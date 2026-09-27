//! Nonlinear device equations.
//!
//! Every device maps its sensed port voltages to injected port currents and
//! fills the Jacobian `d i / d v` (row-major, currents × voltages). The same
//! equations are emitted for ngspice through the element models, so the offline
//! reference and the realtime solver agree by construction.

pub const VT: f64 = 0.025_852; // kT/q at 27 °C, matching ngspice's default temperature.

/// Exponential with a linear continuation above `x = 80` so Newton steps
/// never overflow while staying C1-continuous.
#[inline]
pub fn exp_lim(x: f64) -> (f64, f64) {
    const LIM: f64 = 80.0;
    if x > LIM {
        let e = LIM.exp();
        (e * (1.0 + x - LIM), e)
    } else {
        let e = x.exp();
        (e, e)
    }
}

/// softplus(x) = ln(1 + e^x) and its derivative (the logistic function),
/// written as max(x,0) + ln(1 + e^-|x|) so it never overflows.
#[inline]
pub fn softplus(x: f64) -> (f64, f64) {
    let e = (-x.abs()).exp();
    let value = x.max(0.0) + e.ln_1p();
    let sigmoid = if x >= 0.0 { 1.0 / (1.0 + e) } else { e / (1.0 + e) };
    (value, sigmoid)
}

#[derive(Clone, Copy, Debug)]
pub enum Limit {
    None,
    Junction { nvt: f64, vcrit: f64, symmetric: bool },
    /// Piecewise-linear-ish clamps beyond `vlo`/`vhi`: a step entering a
    /// clamp from outside stops `knee` volts past the rail, so the next
    /// linearization sees the clamp's real slope instead of the weak one
    /// on the far side of the knee.
    Rails { vlo: f64, vhi: f64, knee: f64 },
}

#[derive(Clone, Debug)]
pub enum DeviceEq {
    /// i = Is (exp(v / nVt) - 1)
    Diode { is: f64, nvt: f64 },
    /// Antiparallel pair of identical diodes: i = Is (exp(v/nVt) - exp(-v/nVt)).
    DiodePair { is: f64, nvt: f64 },
    /// Gummel-Poon subset: ports (vbe, vbc) → currents (ib, ic).
    Bjt { is: f64, bf: f64, br: f64, nvt: f64, vaf: f64 },
    /// Shichman-Hodges n-channel JFET: ports (vgs, vgd) → currents (ig_s, ig_d, id)
    /// expressed as (i_gs, i_gd, i_ds).
    Jfet { vto: f64, beta: f64, lambda: f64, is: f64 },
    /// Op-amp input stage: ports (vd, vint) → current into the integrator node:
    /// i = imax · s(gm·vd/imax) − rail clamp, with s(x) = x/√(1+x²).
    OpAmp { imax: f64, gm: f64, gclamp: f64, wclamp: f64, vlo: f64, vhi: f64 },
}

impl DeviceEq {
    pub fn ports_v(&self) -> usize {
        match self {
            DeviceEq::Diode { .. } | DeviceEq::DiodePair { .. } => 1,
            DeviceEq::Bjt { .. } => 2,
            DeviceEq::Jfet { .. } => 2,
            DeviceEq::OpAmp { .. } => 2,
        }
    }

    pub fn ports_i(&self) -> usize {
        match self {
            DeviceEq::Diode { .. } | DeviceEq::DiodePair { .. } => 1,
            DeviceEq::Bjt { .. } => 2,
            DeviceEq::Jfet { .. } => 3,
            DeviceEq::OpAmp { .. } => 1,
        }
    }

    /// Newton step limiting for a port (SPICE `pnjlim` and a rail-relative
    /// variant for the op-amp output clamp).
    pub fn limit(&self, port: usize) -> Limit {
        let vcrit = |is: f64, nvt: f64| nvt * (nvt / (std::f64::consts::SQRT_2 * is)).ln();
        match *self {
            DeviceEq::Diode { is, nvt } => Limit::Junction { nvt, vcrit: vcrit(is, nvt), symmetric: false },
            DeviceEq::DiodePair { is, nvt } => Limit::Junction { nvt, vcrit: vcrit(is, nvt), symmetric: true },
            DeviceEq::Bjt { is, nvt, .. } => Limit::Junction { nvt, vcrit: vcrit(is, nvt), symmetric: false },
            DeviceEq::Jfet { is, .. } if port < 2 => Limit::Junction { nvt: VT, vcrit: vcrit(is, VT), symmetric: false },
            DeviceEq::Jfet { .. } => Limit::None,
            DeviceEq::OpAmp { wclamp, vlo, vhi, .. } if port == 1 => Limit::Rails { vlo, vhi, knee: 2.0 * wclamp },
            DeviceEq::OpAmp { .. } => Limit::None,
        }
    }

    /// Copy of an op-amp with its output swing widened by `widen` volts on
    /// each side; used for DC continuation.
    pub fn widened(&self, widen: f64) -> DeviceEq {
        match self.clone() {
            DeviceEq::OpAmp { imax, gm, gclamp, wclamp, vlo, vhi } => {
                DeviceEq::OpAmp { imax, gm, gclamp, wclamp, vlo: vlo - widen, vhi: vhi + widen }
            }
            other => other,
        }
    }

    /// Evaluate currents `i` and Jacobian `j` (len ports_i × ports_v).
    #[inline]
    pub fn eval(&self, v: &[f64], i: &mut [f64], j: &mut [f64]) {
        match *self {
            DeviceEq::Diode { is, nvt } => {
                let (e, de) = exp_lim(v[0] / nvt);
                i[0] = is * (e - 1.0) + 1e-12 * v[0];
                j[0] = is * de / nvt + 1e-12;
            }
            DeviceEq::DiodePair { is, nvt } => {
                let (ep, dep) = exp_lim(v[0] / nvt);
                let (en, den) = exp_lim(-v[0] / nvt);
                i[0] = is * (ep - en) + 2e-12 * v[0];
                j[0] = is * (dep + den) / nvt + 2e-12;
            }
            DeviceEq::Bjt { is, bf, br, nvt, vaf } => {
                let (ef, def) = exp_lim(v[0] / nvt);
                let (er, der) = exp_lim(v[1] / nvt);
                let dfe = def / nvt;
                let dre = der / nvt;
                // Early effect as in SPICE Gummel-Poon with only VAF set: qb = 1/(1 - vbc/VAF).
                let (q, dq) = if vaf > 0.0 { (1.0 - v[1] / vaf, -1.0 / vaf) } else { (1.0, 0.0) };
                let it = is * (ef - er);
                let ib = is / bf * (ef - 1.0) + is / br * (er - 1.0);
                let ic = it * q - is / br * (er - 1.0);
                // ngspice adds GMIN across each junction; keep it for parity.
                const GMIN: f64 = 1e-12;
                i[0] = ib + GMIN * (v[0] + v[1]);
                i[1] = ic - GMIN * v[1];
                // d ib / d vbe, d ib / d vbc
                j[0] = is / bf * dfe + GMIN;
                j[1] = is / br * dre + GMIN;
                // d ic / d vbe, d ic / d vbc
                j[2] = is * dfe * q;
                j[3] = -is * dre * q + it * dq - is / br * dre - GMIN;
            }
            DeviceEq::Jfet { vto, beta, lambda, is } => {
                let vgs = v[0];
                let vgd = v[1];
                // Gate junctions.
                let (egs, degs) = exp_lim(vgs / VT);
                let (egd, degd) = exp_lim(vgd / VT);
                const GMIN: f64 = 1e-12;
                i[0] = is * (egs - 1.0) + GMIN * vgs;
                i[1] = is * (egd - 1.0) + GMIN * vgd;
                let dgs = is * degs / VT + GMIN;
                let dgd = is * degd / VT + GMIN;
                // Channel current, symmetric in drain/source.
                let vds = vgs - vgd;
                let (forward, vg_eff) = if vds >= 0.0 { (true, vgs) } else { (false, vgd) };
                let vds_abs = vds.abs();
                let vgst = vg_eff - vto;
                let (id, did_dvg, did_dvds) = if vgst <= 0.0 {
                    (0.0, 0.0, 0.0)
                } else if vds_abs < vgst {
                    let base = beta * vds_abs * (2.0 * vgst - vds_abs);
                    let m = 1.0 + lambda * vds_abs;
                    (
                        base * m,
                        beta * 2.0 * vds_abs * m,
                        beta * (2.0 * vgst - 2.0 * vds_abs) * m + base * lambda,
                    )
                } else {
                    let base = beta * vgst * vgst;
                    let m = 1.0 + lambda * vds_abs;
                    (base * m, 2.0 * beta * vgst * m, base * lambda)
                };
                // Chain rule back to (vgs, vgd): vds = vgs - vgd.
                if forward {
                    i[2] = id;
                    // id(vg=vgs, vds): d/dvgs = did_dvg + did_dvds ; d/dvgd = -did_dvds
                    j[4] = did_dvg + did_dvds;
                    j[5] = -did_dvds;
                } else {
                    // Reverse: i_ds = -id(vg=vgd, |vds| = vgd - vgs)
                    i[2] = -id;
                    j[4] = did_dvds;
                    j[5] = -(did_dvg + did_dvds);
                }
                j[0] = dgs;
                j[1] = 0.0;
                j[2] = 0.0;
                j[3] = dgd;
            }
            DeviceEq::OpAmp { imax, gm, gclamp, wclamp, vlo, vhi } => {
                // Algebraic sigmoid: same slope (gm) and slew (imax) as tanh,
                // but its derivative decays as |x|^-3 instead of
                // exponentially, so Newton keeps a usable gradient when the
                // input stage is overdriven.
                let x = gm * v[0] / imax;
                let r = (1.0 + x * x).sqrt();
                let t = x / r;
                // Output swing limit: a softplus-smoothed conductance that
                // switches on beyond each rail. Its slope is bounded by
                // gclamp, unlike an exponential clamp, so Newton cannot
                // overshoot back and forth across the rail.
                let (sh, dh) = softplus((v[1] - vhi) / wclamp);
                let (sl, dl) = softplus((vlo - v[1]) / wclamp);
                i[0] = imax * t - gclamp * wclamp * (sh - sl);
                j[0] = gm / (r * r * r);
                j[1] = -gclamp * (dh + dl);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn numeric_jacobian(dev: &DeviceEq, v: &[f64]) -> Vec<f64> {
        let (nv, ni) = (dev.ports_v(), dev.ports_i());
        let mut out = vec![0.0; ni * nv];
        let mut ip = vec![0.0; ni];
        let mut im = vec![0.0; ni];
        let mut scratch = vec![0.0; ni * nv];
        for c in 0..nv {
            let h = 1e-7;
            let mut vp = v.to_vec();
            let mut vm = v.to_vec();
            vp[c] += h;
            vm[c] -= h;
            dev.eval(&vp, &mut ip, &mut scratch);
            dev.eval(&vm, &mut im, &mut scratch);
            for r in 0..ni {
                out[r * nv + c] = (ip[r] - im[r]) / (2.0 * h);
            }
        }
        out
    }

    fn check(dev: DeviceEq, points: &[&[f64]]) {
        for v in points {
            let (nv, ni) = (dev.ports_v(), dev.ports_i());
            let mut i = vec![0.0; ni];
            let mut j = vec![0.0; ni * nv];
            dev.eval(v, &mut i, &mut j);
            let n = numeric_jacobian(&dev, v);
            for k in 0..j.len() {
                let scale = j[k].abs().max(n[k].abs()).max(1e-9);
                assert!((j[k] - n[k]).abs() / scale < 1e-3, "{dev:?} at {v:?}: analytic {j:?} numeric {n:?}");
            }
        }
    }

    #[test]
    fn jacobians_match_finite_differences() {
        check(DeviceEq::Diode { is: 2.5e-9, nvt: 1.75 * VT }, &[&[0.3], &[0.6], &[-1.0]]);
        check(DeviceEq::DiodePair { is: 2.5e-9, nvt: 1.75 * VT }, &[&[0.3], &[-0.6], &[0.01]]);
        check(
            DeviceEq::Bjt { is: 5.9e-15, bf: 1100.0, br: 1.27, nvt: VT, vaf: 62.0 },
            &[&[0.6, -4.0], &[0.65, 0.2], &[0.2, -0.1]],
        );
        check(
            DeviceEq::Jfet { vto: -2.0, beta: 1e-3, lambda: 0.01, is: 1e-14 },
            &[&[-1.0, -3.0], &[-0.5, -0.6], &[-1.0, 0.5], &[-3.0, -4.0]],
        );
        check(
            DeviceEq::OpAmp { imax: 9e-6, gm: 1.9e-4, gclamp: 1e-3, wclamp: 0.01, vlo: 1.0, vhi: 8.0 },
            &[&[1e-4, 4.0], &[0.2, 7.99], &[-0.01, 1.01]],
        );
    }
}
