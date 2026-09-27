//! Nodal DK-method realtime circuit solver.
//!
//! Linear elements are stamped into an MNA matrix with trapezoidal (or backward
//! Euler) companion models for reactive parts. Nonlinear devices are exposed as
//! port voltages `v = Nv x` and injected currents `Ni i(v)`. Eliminating the
//! linear unknowns leaves a small system per sample:
//!
//! ```text
//! v = p(s, u) + K i(v)          solved by damped Newton
//! ```
//!
//! where `s` holds reactive-element history, `u` the input voltage and `K`,
//! `p` come from precomputed products with `A^-1`. Only knob changes rebuild the
//! matrices; every sample costs a handful of small dense products.

use crate::devices::{DeviceEq, Limit, VT};
use crate::linalg::{Lu, Mat};
use crate::netlist::{is_ground, Element, Kind, Netlist};
use std::collections::HashMap;

type Node = Option<usize>;

#[derive(Clone, Debug)]
struct Resistor {
    name: String,
    a: Node,
    b: Node,
    value: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Integrator {
    Trapezoidal,
    BackwardEuler,
}

#[derive(Clone, Debug)]
struct Reactive {
    a: Node,
    b: Node,
    value: f64,
    inductor: bool,
    method: Integrator,
}

#[derive(Clone, Debug)]
struct Source {
    a: Node,
    b: Node,
    value: f64,
    branch: usize,
    input: bool,
    /// Index among the time-varying (`*@lfo`) sources, driven per sample.
    aux: Option<usize>,
}

#[derive(Clone, Debug)]
struct Vcvs {
    p: Node,
    n: Node,
    cp: Node,
    cn: Node,
    gain: f64,
    branch: usize,
}

#[derive(Clone, Debug)]
struct Device {
    eq: DeviceEq,
    sense: Vec<(Node, Node)>,
    /// (into, out_of) node pairs for each current.
    inject: Vec<(Node, Node)>,
    v_offset: usize,
    i_offset: usize,
}

/// Elaborated circuit: all subcircuits expanded, nodes numbered.
#[derive(Clone, Debug)]
pub struct Circuit {
    nx: usize,
    resistors: Vec<Resistor>,
    reactives: Vec<Reactive>,
    sources: Vec<Source>,
    vcvs: Vec<Vcvs>,
    devices: Vec<Device>,
    nv: usize,
    ni: usize,
    output: usize,
    limits: Vec<Limit>,
    pub node_names: Vec<String>,
    /// DC values of the time-varying sources (their starting voltages).
    pub aux_initial: Vec<f64>,
}

struct Builder {
    nodes: HashMap<String, usize>,
    names: Vec<String>,
    branches: usize,
}

impl Builder {
    fn node(&mut self, name: &str) -> Node {
        if is_ground(name) {
            return None;
        }
        let key = name.to_ascii_lowercase();
        if let Some(&i) = self.nodes.get(&key) {
            return Some(i);
        }
        let i = self.names.len();
        self.nodes.insert(key, i);
        self.names.push(name.to_string());
        Some(i)
    }

    fn internal(&mut self, owner: &str, suffix: &str) -> Node {
        self.node(&format!("{owner}#{suffix}"))
    }
}

pub static DEBUG_NEWTON: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Newton stops once the port equations balance to this many volts.
const NEWTON_TOL: f64 = 1e-5;

/// Op-amp output-swing clamp: conductance beyond the rail and the softplus
/// knee width. 1 mS holds the integrator within ~10 mV of the rail.
pub const OPAMP_GCLAMP: f64 = 1e-3;
pub const OPAMP_WCLAMP: f64 = 0.01;

/// Leakage across an OTA's bias input (see the OTA builder).
pub const OTA_RLEAK: f64 = 1e9;

/// Fixed internal compensation capacitance for the op-amp macro model.
pub const OPAMP_CC: f64 = 30e-12;

impl Circuit {
    pub fn build(net: &Netlist, be_elements: &[String]) -> Result<Circuit, String> {
        let mut b = Builder { nodes: HashMap::new(), names: Vec::new(), branches: 0 };
        let mut resistors = Vec::new();
        let mut reactives = Vec::new();
        let mut sources_pending: Vec<(Node, Node, f64, bool, Option<usize>)> = Vec::new();
        let aux_index = |name: &str| net.lfos.iter().position(|l| l.source.eq_ignore_ascii_case(name));
        let mut vcvs_pending: Vec<(Node, Node, Node, Node, f64)> = Vec::new();
        let mut devices = Vec::new();
        let is_be = |name: &str| be_elements.iter().any(|e| e.eq_ignore_ascii_case(name));

        for el in &net.elements {
            let Element { name, kind, nodes, value } = el;
            match kind {
                Kind::Resistor => {
                    let (a, bb) = (b.node(&nodes[0]), b.node(&nodes[1]));
                    resistors.push(Resistor { name: name.clone(), a, b: bb, value: *value });
                }
                Kind::Capacitor | Kind::Inductor => {
                    let (a, bb) = (b.node(&nodes[0]), b.node(&nodes[1]));
                    reactives.push(Reactive {
                        a,
                        b: bb,
                        value: *value,
                        inductor: *kind == Kind::Inductor,
                        method: if is_be(name) { Integrator::BackwardEuler } else { Integrator::Trapezoidal },
                    });
                }
                Kind::VSource => {
                    let (a, bb) = (b.node(&nodes[0]), b.node(&nodes[1]));
                    sources_pending.push((a, bb, *value, name.eq_ignore_ascii_case(&net.input), aux_index(name)));
                }
                Kind::Vcvs { gain } => {
                    let n: Vec<Node> = nodes.iter().map(|x| b.node(x)).collect();
                    vcvs_pending.push((n[0], n[1], n[2], n[3], *gain));
                }
                Kind::Diode { model } => {
                    let m = &net.diode_models[model];
                    let anode = b.node(&nodes[0]);
                    let cathode = b.node(&nodes[1]);
                    let inner = if m.rs > 0.0 {
                        let mid = b.internal(name, "a");
                        resistors.push(Resistor { name: format!("{name}#rs"), a: anode, b: mid, value: m.rs });
                        mid
                    } else {
                        anode
                    };
                    devices.push(Device {
                        eq: DeviceEq::Diode { is: m.is, nvt: m.n * VT },
                        sense: vec![(inner, cathode)],
                        inject: vec![(cathode, inner)],
                        v_offset: 0,
                        i_offset: 0,
                    });
                }
                Kind::Bjt { model } => {
                    let m = &net.bjt_models[model];
                    let mut c = b.node(&nodes[0]);
                    let mut bn = b.node(&nodes[1]);
                    let mut e = b.node(&nodes[2]);
                    for (r, node, tag) in [(m.rc, &mut c, "c"), (m.rb, &mut bn, "b"), (m.re, &mut e, "e")] {
                        if r > 0.0 {
                            let inner = b.internal(name, tag);
                            resistors.push(Resistor { name: format!("{name}#r{tag}"), a: *node, b: inner, value: r });
                            *node = inner;
                        }
                    }
                    let eq = DeviceEq::Bjt { is: m.is, bf: m.bf, br: m.br, nvt: m.nf * VT, vaf: m.vaf };
                    // PNP equations are NPN with every polarity reversed.
                    let (sense, inject) = if m.pnp {
                        (vec![(e, bn), (c, bn)], vec![(bn, e), (c, e)])
                    } else {
                        (vec![(bn, e), (bn, c)], vec![(e, bn), (e, c)])
                    };
                    devices.push(Device { eq, sense, inject, v_offset: 0, i_offset: 0 });
                }
                Kind::Jfet { model } => {
                    let m = &net.jfet_models[model];
                    let d = b.node(&nodes[0]);
                    let g = b.node(&nodes[1]);
                    let s = b.node(&nodes[2]);
                    let eq = DeviceEq::Jfet { vto: m.vto, beta: m.beta, lambda: m.lambda, is: m.is };
                    let (sense, inject) = if m.pchannel {
                        (vec![(s, g), (d, g)], vec![(g, s), (g, d), (d, s)])
                    } else {
                        (vec![(g, s), (g, d)], vec![(s, g), (d, g), (s, d)])
                    };
                    devices.push(Device { eq, sense, inject, v_offset: 0, i_offset: 0 });
                }
                Kind::Ota { model } => {
                    let m = &net.ota_models[model];
                    let n: Vec<Node> = nodes.iter().map(|x| b.node(x)).collect();
                    let (inp, inn, out, abc, vp, vn) = (n[0], n[1], n[2], n[3], n[4], n[5]);
                    // The bias input is usually fed only through a resistor
                    // from a transistor: without a DC path of its own that
                    // node island rests on GMIN and the DK matrices become
                    // ill-conditioned (1e12 V/A). 1 GOhm of input leakage
                    // (under 0.05% of any useful Iabc) keeps them sane.
                    resistors.push(Resistor { name: format!("{name}#rleak"), a: abc, b: vn, value: OTA_RLEAK });
                    devices.push(Device {
                        eq: DeviceEq::Ota { is: m.is, nvt: m.n * VT, beta: m.beta, v0: m.v0, w: m.w },
                        sense: vec![(inp, inn), (abc, vn), (vp, out), (out, vn)],
                        // (into, out_of) for iabc, ia, ib, ibp, ibn.
                        inject: vec![(vn, abc), (out, vp), (vn, out), (vn, inp), (vn, inn)],
                        v_offset: 0,
                        i_offset: 0,
                    });
                }
                Kind::OpAmp { model } => {
                    let m = &net.opamp_models[model];
                    let inp = b.node(&nodes[0]);
                    let inn = b.node(&nodes[1]);
                    let out = b.node(&nodes[2]);
                    let int = b.internal(name, "int");
                    let o1 = b.internal(name, "o1");
                    let gm = 2.0 * std::f64::consts::PI * m.gbw * OPAMP_CC;
                    let imax = m.slew * OPAMP_CC;
                    resistors.push(Resistor { name: format!("{name}#ro"), a: int, b: None, value: m.aol / gm });
                    reactives.push(Reactive {
                        a: int,
                        b: None,
                        value: OPAMP_CC,
                        inductor: false,
                        // Trapezoidal like every other capacitor: backward
                        // Euler here made slewing first-order accurate (4%
                        // error vs ngspice at 96 kHz; trapezoidal: 0.4%).
                        method: Integrator::Trapezoidal,
                    });
                    vcvs_pending.push((o1, None, int, None, 1.0));
                    resistors.push(Resistor { name: format!("{name}#rout"), a: o1, b: out, value: m.rout });
                    devices.push(Device {
                        eq: DeviceEq::OpAmp { imax, gm, gclamp: OPAMP_GCLAMP, wclamp: OPAMP_WCLAMP, vlo: m.vlo, vhi: m.vhi },
                        sense: vec![(inp, inn), (int, None)],
                        inject: vec![(int, None)],
                        v_offset: 0,
                        i_offset: 0,
                    });
                }
            }
        }

        let output = b.node(&net.output).ok_or("output cannot be ground")?;
        let n_nodes = b.names.len();
        let mut branch = n_nodes;
        let mut aux_initial = vec![0.0; net.lfos.len()];
        for &(_, _, value, _, aux) in &sources_pending {
            if let Some(k) = aux {
                aux_initial[k] = value;
            }
        }
        let sources = sources_pending
            .into_iter()
            .map(|(a, bb, value, input, aux)| {
                let s = Source { a, b: bb, value, branch, input, aux };
                branch += 1;
                s
            })
            .collect::<Vec<_>>();
        let vcvs = vcvs_pending
            .into_iter()
            .map(|(p, n, cp, cn, gain)| {
                let v = Vcvs { p, n, cp, cn, gain, branch };
                branch += 1;
                v
            })
            .collect::<Vec<_>>();
        b.branches = branch - n_nodes;

        merge_antiparallel_diodes(&mut devices);

        let mut nv = 0;
        let mut ni = 0;
        let mut limits = Vec::new();
        for d in &mut devices {
            d.v_offset = nv;
            d.i_offset = ni;
            for p in 0..d.eq.ports_v() {
                limits.push(d.eq.limit(p));
            }
            nv += d.eq.ports_v();
            ni += d.eq.ports_i();
        }

        Ok(Circuit {
            nx: branch,
            resistors,
            reactives,
            sources,
            vcvs,
            devices,
            nv,
            ni,
            output,
            limits,
            node_names: b.names,
            aux_initial,
        })
    }

    pub fn nonlinear_ports(&self) -> usize {
        self.nv
    }

    pub fn unknowns(&self) -> usize {
        self.nx
    }

    pub fn aux_sources(&self) -> usize {
        self.aux_initial.len()
    }

    /// Copy with every op-amp's output swing widened (DC continuation).
    fn with_widened_opamps(&self, widen: f64) -> Circuit {
        let mut c = self.clone();
        for d in &mut c.devices {
            d.eq = d.eq.widened(widen);
            for p in 0..d.eq.ports_v() {
                c.limits[d.v_offset + p] = d.eq.limit(p);
            }
        }
        c
    }

    fn stamp_g(a: &mut Mat, n1: Node, n2: Node, g: f64) {
        if let Some(i) = n1 {
            a.add(i, i, g);
        }
        if let Some(j) = n2 {
            a.add(j, j, g);
        }
        if let (Some(i), Some(j)) = (n1, n2) {
            a.add(i, j, -g);
            a.add(j, i, -g);
        }
    }

    /// MNA matrix. `dt = None` builds the DC matrix (capacitors open,
    /// inductors as 1 mΩ).
    fn matrix(&self, overrides: &HashMap<String, f64>, dt: Option<f64>) -> Mat {
        let mut a = Mat::zeros(self.nx, self.nx);
        for r in &self.resistors {
            let value = overrides.get(&r.name.to_ascii_lowercase()).copied().unwrap_or(r.value).max(1e-3);
            Self::stamp_g(&mut a, r.a, r.b, 1.0 / value);
        }
        for x in &self.reactives {
            let g = match dt {
                Some(t) => companion_g(x, t),
                None if x.inductor => 1e3,
                None => 0.0,
            };
            if g != 0.0 {
                Self::stamp_g(&mut a, x.a, x.b, g);
            }
        }
        for s in &self.sources {
            if let Some(i) = s.a {
                a.add(i, s.branch, 1.0);
                a.add(s.branch, i, 1.0);
            }
            if let Some(j) = s.b {
                a.add(j, s.branch, -1.0);
                a.add(s.branch, j, -1.0);
            }
        }
        for v in &self.vcvs {
            if let Some(i) = v.p {
                a.add(i, v.branch, 1.0);
                a.add(v.branch, i, 1.0);
            }
            if let Some(j) = v.n {
                a.add(j, v.branch, -1.0);
                a.add(v.branch, j, -1.0);
            }
            if let Some(i) = v.cp {
                a.add(v.branch, i, -v.gain);
            }
            if let Some(j) = v.cn {
                a.add(v.branch, j, v.gain);
            }
        }
        // GMIN on every node keeps DC-isolated nodes solvable, as in SPICE.
        let gmin = 1e-12;
        for i in 0..self.node_names.len() {
            a.add(i, i, gmin);
        }
        a
    }

    fn rhs_parts(&self) -> (Mat, Mat, Mat, Mat) {
        let ns = self.reactives.len();
        let mut bs = Mat::zeros(self.nx, ns);
        for (k, x) in self.reactives.iter().enumerate() {
            // Capacitor history current enters node a; inductor history leaves it.
            let sign = if x.inductor { -1.0 } else { 1.0 };
            if let Some(i) = x.a {
                bs.add(i, k, sign);
            }
            if let Some(j) = x.b {
                bs.add(j, k, -sign);
            }
        }
        // Column 0: audio input; column 1 + k: time-varying source k.
        let mut bu = Mat::zeros(self.nx, 1 + self.aux_initial.len());
        let mut b0 = Mat::zeros(self.nx, 1);
        for s in &self.sources {
            if s.input {
                bu.add(s.branch, 0, 1.0);
            } else if let Some(k) = s.aux {
                bu.add(s.branch, 1 + k, 1.0);
            } else {
                b0.add(s.branch, 0, s.value);
            }
        }
        let mut ni = Mat::zeros(self.nx, self.ni);
        for d in &self.devices {
            for (k, (into, out)) in d.inject.iter().enumerate() {
                let col = d.i_offset + k;
                if let Some(i) = into {
                    ni.add(*i, col, 1.0);
                }
                if let Some(j) = out {
                    ni.add(*j, col, -1.0);
                }
            }
        }
        (bs, bu, b0, ni)
    }

    fn row_selectors(&self) -> (Mat, Mat, Mat) {
        let mut nvm = Mat::zeros(self.nv, self.nx);
        for d in &self.devices {
            for (k, (p, n)) in d.sense.iter().enumerate() {
                let row = d.v_offset + k;
                if let Some(i) = p {
                    nvm.add(row, *i, 1.0);
                }
                if let Some(j) = n {
                    nvm.add(row, *j, -1.0);
                }
            }
        }
        let ns = self.reactives.len();
        let mut nst = Mat::zeros(ns, self.nx);
        for (k, x) in self.reactives.iter().enumerate() {
            if let Some(i) = x.a {
                nst.add(k, i, 1.0);
            }
            if let Some(j) = x.b {
                nst.add(k, j, -1.0);
            }
        }
        let mut no = Mat::zeros(1, self.nx);
        no.set(0, self.output, 1.0);
        (nvm, nst, no)
    }
}

/// Two identical series-resistance-free diodes across the same nodes in
/// opposite directions behave as one sinh port, which halves their Newton
/// dimension without changing the circuit equations.
fn merge_antiparallel_diodes(devices: &mut Vec<Device>) {
    let mut k = 0;
    while k < devices.len() {
        let DeviceEq::Diode { is, nvt } = devices[k].eq else {
            k += 1;
            continue;
        };
        let (a, b) = devices[k].sense[0];
        let partner = devices.iter().enumerate().position(|(idx, d)| {
            idx != k
                && matches!(d.eq, DeviceEq::Diode { is: i2, nvt: n2 } if i2 == is && n2 == nvt)
                && d.sense[0] == (b, a)
        });
        match partner {
            Some(p) => {
                devices[k].eq = DeviceEq::DiodePair { is, nvt };
                devices.remove(p);
                if p < k {
                    k -= 1;
                }
                k += 1;
            }
            None => k += 1,
        }
    }
}

fn companion_g(x: &Reactive, dt: f64) -> f64 {
    match (x.inductor, x.method) {
        (false, Integrator::Trapezoidal) => 2.0 * x.value / dt,
        (false, Integrator::BackwardEuler) => x.value / dt,
        (true, Integrator::Trapezoidal) => dt / (2.0 * x.value),
        (true, Integrator::BackwardEuler) => dt / x.value,
    }
}

/// Precomputed reduced system for one set of knob positions.
#[derive(Clone, Debug)]
struct Reduced {
    // Port voltages: p = mv_s s + mv_u u + mv_0 ; v = p + k i
    mv_s: Mat,
    mv_u: Vec<f64>,
    /// Columns for the time-varying sources (rows × aux).
    mv_a: Mat,
    mv_0: Vec<f64>,
    /// K transposed, row-major (ni × nv), for contiguous column access.
    kt: Vec<f64>,
    // Reactive voltages
    mst_s: Mat,
    mst_u: Vec<f64>,
    mst_a: Mat,
    mst_0: Vec<f64>,
    mst_i: Mat,
    // Output
    mo_s: Vec<f64>,
    mo_u: f64,
    mo_a: Vec<f64>,
    mo_0: f64,
    mo_i: Vec<f64>,
}

fn reduce(circuit: &Circuit, overrides: &HashMap<String, f64>, dt: Option<f64>) -> Result<Reduced, String> {
    let a = circuit.matrix(overrides, dt);
    let lu = Lu::factor(&a).ok_or("singular MNA matrix")?;
    let (bs, bu, b0, ni) = circuit.rhs_parts();
    let ns = bs.cols;
    let nin = ni.cols;
    let na = bu.cols - 1;
    // Columns: [states | input | aux... | constant | device currents]
    let (cu, ca, c0, ci) = (ns, ns + 1, ns + 1 + na, ns + 2 + na);
    let mut rhs = Mat::zeros(circuit.nx, ci + nin);
    for r in 0..circuit.nx {
        for c in 0..ns {
            rhs.set(r, c, bs.at(r, c));
        }
        rhs.set(r, cu, bu.at(r, 0));
        for k in 0..na {
            rhs.set(r, ca + k, bu.at(r, 1 + k));
        }
        rhs.set(r, c0, b0.at(r, 0));
        for c in 0..nin {
            rhs.set(r, ci + c, ni.at(r, c));
        }
    }
    let z = lu.solve_mat(&rhs);
    let (nvm, nst, no) = circuit.row_selectors();
    let split = |m: &Mat| -> (Mat, Vec<f64>, Mat, Vec<f64>, Mat) {
        let prod = m.mul(&z);
        let mut s = Mat::zeros(prod.rows, ns);
        let mut u = vec![0.0; prod.rows];
        let mut a = Mat::zeros(prod.rows, na);
        let mut k0 = vec![0.0; prod.rows];
        let mut i = Mat::zeros(prod.rows, nin);
        for r in 0..prod.rows {
            for c in 0..ns {
                s.set(r, c, prod.at(r, c));
            }
            u[r] = prod.at(r, cu);
            for k in 0..na {
                a.set(r, k, prod.at(r, ca + k));
            }
            k0[r] = prod.at(r, c0);
            for c in 0..nin {
                i.set(r, c, prod.at(r, ci + c));
            }
        }
        (s, u, a, k0, i)
    };
    let (mv_s, mv_u, mv_a, mv_0, k) = split(&nvm);
    let (mst_s, mst_u, mst_a, mst_0, mst_i) = split(&nst);
    let (mo_s, mo_u, mo_a, mo_0, mo_i) = split(&no);
    let mut kt = vec![0.0; k.rows * k.cols];
    for r in 0..k.rows {
        for c in 0..k.cols {
            kt[c * k.rows + r] = k.at(r, c);
        }
    }
    Ok(Reduced {
        mv_s,
        mv_u,
        mv_a,
        mv_0,
        kt,
        mst_s,
        mst_u,
        mst_a,
        mst_0,
        mst_i,
        mo_s: mo_s.data,
        mo_u: mo_u[0],
        mo_a: mo_a.data,
        mo_0: mo_0[0],
        mo_i: mo_i.data,
    })
}

/// Newton working set, kept apart from the reduced matrices so the solve can
/// borrow both.
struct Newton {
    v: Vec<f64>,
    i: Vec<f64>,
    p: Vec<f64>,
    /// LU factors of the Newton Jacobian, column-major (nv × nv), reused
    /// across iterations and samples until convergence slows (chord method).
    lu: Vec<f64>,
    piv: Vec<usize>,
    lu_valid: bool,
    /// Device Jacobian blocks, packed per device (pi × pv row-major).
    djac: Vec<f64>,
    dv: Vec<f64>,
    /// Last converged (p, v) pair and the K it belongs to: the anchor for
    /// the Levenberg-Marquardt and homotopy fallbacks.
    p_ok: Vec<f64>,
    v_ok: Vec<f64>,
    k_ok: usize,
    p_target: Vec<f64>,
    v_good: Vec<f64>,
    pub refactors: u64,
}

impl Newton {
    fn new(circuit: &Circuit) -> Self {
        let nv = circuit.nv;
        let packed: usize = circuit.devices.iter().map(|d| d.eq.ports_v() * d.eq.ports_i()).sum();
        Self {
            v: vec![0.0; nv],
            i: vec![0.0; circuit.ni],
            p: vec![0.0; nv],
            lu: vec![0.0; nv * nv],
            piv: vec![0; nv],
            lu_valid: false,
            djac: vec![0.0; packed],
            dv: vec![0.0; nv],
            p_ok: vec![0.0; nv],
            v_ok: vec![0.0; nv],
            k_ok: 0,
            p_target: vec![0.0; nv],
            v_good: vec![0.0; nv],
            refactors: 0,
        }
    }

    #[inline]
    fn eval_devices(&mut self, circuit: &Circuit) {
        let mut off = 0;
        for d in &circuit.devices {
            let (pv, pi) = (d.eq.ports_v(), d.eq.ports_i());
            d.eq.eval(
                &self.v[d.v_offset..d.v_offset + pv],
                &mut self.i[d.i_offset..d.i_offset + pi],
                &mut self.djac[off..off + pv * pi],
            );
            off += pv * pi;
        }
    }

    /// Assemble J = K dI/dV - I at the last evaluated point and factor it.
    fn refactor(&mut self, circuit: &Circuit, kt: &[f64]) -> bool {
        let nv = circuit.nv;
        let mut lu = std::mem::take(&mut self.lu);
        self.assemble_jacobian(circuit, kt, &mut lu);
        self.lu = lu;
        self.refactors += 1;
        self.lu_valid = lu_factor_colmajor(&mut self.lu, &mut self.piv, nv);
        self.lu_valid
    }

    /// J = K dI/dV - I at the last evaluated point, column-major (nv × nv).
    fn assemble_jacobian(&self, circuit: &Circuit, kt: &[f64], out: &mut [f64]) {
        let nv = circuit.nv;
        out.iter_mut().for_each(|x| *x = 0.0);
        let mut off = 0;
        for d in &circuit.devices {
            let (pv, pi) = (d.eq.ports_v(), d.eq.ports_i());
            for r in 0..pi {
                let m = d.i_offset + r;
                let kcol = &kt[m * nv..(m + 1) * nv];
                for c in 0..pv {
                    let dij = self.djac[off + r * pv + c];
                    if dij == 0.0 {
                        continue;
                    }
                    let jcol = &mut out[(d.v_offset + c) * nv..(d.v_offset + c + 1) * nv];
                    for (j, &k) in jcol.iter_mut().zip(kcol) {
                        *j += k * dij;
                    }
                }
            }
            off += pv * pi;
        }
        for r in 0..nv {
            out[r * nv + r] -= 1.0;
        }
    }

    /// F = p + K i - v at the current point (devices evaluated here).
    /// Returns (max |F|, |F|^2).
    fn residual_into(&mut self, circuit: &Circuit, kt: &[f64], f: &mut [f64]) -> (f64, f64) {
        let nv = circuit.nv;
        self.eval_devices(circuit);
        f.copy_from_slice(&self.p);
        for (m, &im) in self.i.iter().enumerate() {
            let col = &kt[m * nv..(m + 1) * nv];
            for (x, &k) in f.iter_mut().zip(col) {
                *x += k * im;
            }
        }
        let (mut max, mut sq) = (0.0f64, 0.0f64);
        for (x, &v) in f.iter_mut().zip(&self.v) {
            *x -= v;
            max = max.max(x.abs());
            sq += *x * *x;
        }
        (max, sq)
    }

    /// Levenberg-Marquardt on |F|^2: monotone in the residual, so it cannot
    /// lock into the limit cycles that plain Newton with junction limiting
    /// falls into around saturating op-amp loops; with lambda -> 0 it is
    /// Newton again and converges quadratically. Returns (iterations, ok).
    fn levenberg_marquardt(&mut self, circuit: &Circuit, kt: &[f64], max_iter: usize, tol: f64) -> (usize, bool) {
        let nv = circuit.nv;
        let mut f = vec![0.0; nv];
        let mut f_try = vec![0.0; nv];
        let mut jac = vec![0.0; nv * nv];
        let mut ata = vec![0.0; nv * nv];
        let mut m = vec![0.0; nv * nv];
        let mut g = vec![0.0; nv];
        let mut d = vec![0.0; nv];
        let mut piv = vec![0usize; nv];
        let mut v_old = vec![0.0; nv];
        let (mut max, mut sq) = self.residual_into(circuit, kt, &mut f);
        let mut lambda = 1e-3f64;
        let mut iters = 1;
        while iters < max_iter {
            if max < tol {
                self.lu_valid = false;
                return (iters, true);
            }
            self.assemble_jacobian(circuit, kt, &mut jac);
            // Normal equations A = J^T J, g = J^T F (J column-major).
            for a in 0..nv {
                let ca = &jac[a * nv..(a + 1) * nv];
                g[a] = ca.iter().zip(&f).map(|(x, y)| x * y).sum();
                for b in 0..nv {
                    let cb = &jac[b * nv..(b + 1) * nv];
                    ata[b * nv + a] = ca.iter().zip(cb).map(|(x, y)| x * y).sum();
                }
            }
            let mut accepted = false;
            while !accepted && iters < max_iter {
                m.copy_from_slice(&ata);
                for a in 0..nv {
                    m[a * nv + a] += lambda * (ata[a * nv + a] + 1e-12);
                    d[a] = -g[a];
                }
                if !lu_factor_colmajor(&mut m, &mut piv, nv) {
                    lambda *= 10.0;
                    iters += 1;
                    continue;
                }
                lu_apply_colmajor(&m, &piv, &mut d, nv);
                v_old.copy_from_slice(&self.v);
                for a in 0..nv {
                    self.v[a] += d[a];
                }
                let (max_try, sq_try) = self.residual_into(circuit, kt, &mut f_try);
                iters += 1;
                if sq_try < sq && sq_try.is_finite() {
                    accepted = true;
                    f.copy_from_slice(&f_try);
                    max = max_try;
                    sq = sq_try;
                    lambda = (lambda / 5.0).max(1e-12);
                } else {
                    self.v.copy_from_slice(&v_old);
                    lambda *= 4.0;
                    if lambda > 1e12 {
                        self.residual_into(circuit, kt, &mut f);
                        self.lu_valid = false;
                        return (iters, false);
                    }
                }
            }
            if !accepted {
                // Leave devices evaluated at the restored point.
                self.residual_into(circuit, kt, &mut f);
            }
        }
        self.lu_valid = false;
        (iters, max < tol)
    }

    /// Solve v = p + K i(v). `kt` is K transposed (ni × nv). Convergence is
    /// judged on the residual (volts), never on the step: a stale chord
    /// Jacobian can take tiny steps far from the solution.
    /// Returns (iterations, converged).
    fn solve(&mut self, circuit: &Circuit, kt: &[f64], max_iter: usize, tol: f64) -> (usize, bool) {
        let nv = circuit.nv;
        if nv == 0 {
            return (0, true);
        }
        let mut last_residual = f64::INFINITY;
        for iter in 0..max_iter {
            self.eval_devices(circuit);
            // F = p + K i - v ; stored negated in dv as the Newton RHS.
            self.dv.copy_from_slice(&self.p);
            for (m, &im) in self.i.iter().enumerate() {
                let col = &kt[m * nv..(m + 1) * nv];
                for (f, &k) in self.dv.iter_mut().zip(col) {
                    *f += k * im;
                }
            }
            let mut residual = 0.0f64;
            for (f, &v) in self.dv.iter_mut().zip(&self.v) {
                *f = v - *f;
                residual = residual.max(f.abs());
            }
            if residual < tol {
                return (iter + 1, true);
            }
            // Slow contraction means the reused Jacobian is stale.
            if !self.lu_valid || residual > 0.1 * last_residual {
                if !self.refactor(circuit, kt) {
                    return (iter + 1, false);
                }
            }
            last_residual = residual;
            lu_apply_colmajor(&self.lu, &self.piv, &mut self.dv, nv);
            for r in 0..nv {
                let old = self.v[r];
                let new = old + self.dv[r];
                let limited = match circuit.limits[r] {
                    Limit::Junction { nvt, vcrit, symmetric } => pnjlim(new, old, nvt, vcrit, symmetric),
                    Limit::Rails { vlo, vhi, knee } => raillim(new, old, vlo, vhi, knee),
                    Limit::None => new,
                };
                self.v[r] = limited;
            }
        }
        self.eval_devices(circuit);
        self.lu_valid = false;
        (max_iter, false)
    }
}

/// Deepest sub-stepping level (2^5 = 32 sub-steps per sample).
const MAX_SUBSTEP_LEVEL: usize = 5;

/// One implicit step: solve the nonlinear ports, then commit reactive
/// history. State is only touched when Newton converged.
/// Returns (output, converged, iterations).
#[allow(clippy::too_many_arguments)]
#[inline]
fn advance(
    circuit: &Circuit,
    newton: &mut Newton,
    r: &Reduced,
    g: &[f64],
    alpha: &[f64],
    beta: &[f64],
    state: &mut [f64],
    vst: &mut [f64],
    u: f64,
    aux: &[f64],
    max_iter: usize,
) -> (f64, bool, usize) {
    let nv = circuit.nv;
    for k in 0..nv {
        newton.p[k] = r.mv_u[k] * u + r.mv_0[k];
    }
    r.mv_s.mul_vec_add(state, &mut newton.p);
    if !aux.is_empty() {
        r.mv_a.mul_vec_add(aux, &mut newton.p);
    }
    let (mut iters, mut ok) = newton.solve(circuit, &r.kt, max_iter, NEWTON_TOL);
    // Fallbacks for the rare sample plain Newton cannot finish, both anchored
    // at the last converged point of this same system (same K).
    if !ok && newton.k_ok == r.kt.as_ptr() as usize {
        newton.v.copy_from_slice(&newton.v_ok);
        let (more, ok2) = newton.levenberg_marquardt(circuit, &r.kt, 60, NEWTON_TOL);
        iters += more;
        ok = ok2;
    }
    if !ok && newton.k_ok == r.kt.as_ptr() as usize {
        let (more, ok2) = newton.homotopy(circuit, &r.kt);
        iters += more;
        ok = ok2;
    }
    if !ok {
        return (0.0, false, iters);
    }
    newton.p_ok.copy_from_slice(&newton.p);
    newton.v_ok.copy_from_slice(&newton.v);
    newton.k_ok = r.kt.as_ptr() as usize;
    let ns = state.len();
    for k in 0..ns {
        vst[k] = r.mst_u[k] * u + r.mst_0[k];
    }
    r.mst_s.mul_vec_add(state, vst);
    r.mst_i.mul_vec_add(&newton.i, vst);
    let mut y = r.mo_u * u + r.mo_0;
    if !aux.is_empty() {
        r.mst_a.mul_vec_add(aux, vst);
        for (a, b) in r.mo_a.iter().zip(aux) {
            y += a * b;
        }
    }
    for (a, b) in r.mo_s.iter().zip(state.iter()) {
        y += a * b;
    }
    for (a, b) in r.mo_i.iter().zip(&newton.i) {
        y += a * b;
    }
    for k in 0..ns {
        state[k] = alpha[k] * g[k] * vst[k] + beta[k] * state[k];
    }
    (y, true, iters)
}

/// Current through a reactive element at the end of the last step, from its
/// companion history `h` (which already points at the next step).
#[inline]
fn history_current(x: &Reactive, h: f64, v: f64, g: f64) -> f64 {
    match (x.inductor, x.method) {
        (_, Integrator::Trapezoidal) => h - g * v,
        (false, Integrator::BackwardEuler) => 0.0,
        (true, Integrator::BackwardEuler) => h,
    }
}

/// Companion history for the next step from end-of-step voltage and current.
#[inline]
fn history_from(x: &Reactive, v: f64, i: f64, g: f64) -> f64 {
    match (x.inductor, x.method) {
        (_, Integrator::Trapezoidal) => g * v + i,
        (false, Integrator::BackwardEuler) => g * v,
        (true, Integrator::BackwardEuler) => i,
    }
}

/// SPICE junction voltage limiting: forward-bias increases are compressed
/// logarithmically so exp() never overshoots; decreases pass unchanged.
#[inline]
fn pnjlim(new: f64, old: f64, nvt: f64, vcrit: f64, symmetric: bool) -> f64 {
    if !symmetric {
        return junction_limit(new, old, nvt, vcrit);
    }
    // Antiparallel pair: limit whichever junction is (or becomes) forward
    // biased; a sign change restarts the other junction from zero.
    match (old >= 0.0, new >= 0.0) {
        (true, true) => junction_limit(new, old, nvt, vcrit),
        (false, false) => -junction_limit(-new, -old, nvt, vcrit),
        (true, false) => -junction_limit(-new, 0.0, nvt, vcrit),
        (false, true) => junction_limit(new, 0.0, nvt, vcrit),
    }
}

/// One exponential junction. Increases follow SPICE `pnjlim`. Decreases from
/// strong forward bias take the logarithmic step that lands exactly on the
/// linearized target current, instead of creeping down ~nVt per iteration
/// as plain Newton does on the steep side of an exponential.
#[inline]
fn junction_limit(new: f64, old: f64, nvt: f64, vcrit: f64) -> f64 {
    if new >= old {
        if new > vcrit && new - old > 2.0 * nvt {
            if old > 0.0 {
                let arg = 1.0 + (new - old) / nvt;
                if arg > 0.0 {
                    old + nvt * arg.ln()
                } else {
                    vcrit
                }
            } else {
                nvt * (new / nvt).ln()
            }
        } else {
            new
        }
    } else if old > vcrit {
        let arg = 1.0 + (new - old) / nvt;
        if arg > 0.0 {
            old + nvt * arg.ln()
        } else {
            new
        }
    } else {
        new
    }
}

/// Knee limiting for the op-amp output clamp (see `Limit::Rails`).
#[inline]
fn raillim(new: f64, old: f64, vlo: f64, vhi: f64, knee: f64) -> f64 {
    if new > vhi + knee && old <= vhi + knee {
        vhi + knee
    } else if new < vlo - knee && old >= vlo - knee {
        vlo - knee
    } else {
        new
    }
}

impl Newton {
    /// Continuation in p: the last converged point solves v = p_ok + K i(v)
    /// exactly and, with K fixed, the solution moves continuously with p.
    /// Walk p along the straight line to the target, halving the stride on
    /// failure (the homotopy strategy of Holters & Zölzer's ACME.jl).
    fn homotopy(&mut self, circuit: &Circuit, kt: &[f64]) -> (usize, bool) {
        self.p_target.copy_from_slice(&self.p);
        self.v.copy_from_slice(&self.v_ok);
        self.v_good.copy_from_slice(&self.v_ok);
        let (mut t, mut h) = (0.0f64, 0.25f64);
        let mut iters = 0;
        while t < 1.0 {
            let next = (t + h).min(1.0);
            for k in 0..self.p.len() {
                self.p[k] = self.p_ok[k] + next * (self.p_target[k] - self.p_ok[k]);
            }
            self.lu_valid = false;
            let (it, ok) = self.solve(circuit, kt, 30, NEWTON_TOL);
            iters += it;
            if ok {
                t = next;
                self.v_good.copy_from_slice(&self.v);
                h = (h * 2.0).min(1.0);
            } else {
                self.v.copy_from_slice(&self.v_good);
                h *= 0.5;
                if h < 1.0 / 4096.0 {
                    self.p.copy_from_slice(&self.p_target);
                    return (iters, false);
                }
            }
        }
        (iters, true)
    }
}

/// In-place LU with partial pivoting of a column-major matrix.
fn lu_factor_colmajor(a: &mut [f64], piv: &mut [usize], n: usize) -> bool {
    for k in 0..n {
        let col = &a[k * n..(k + 1) * n];
        let mut p = k;
        let mut best = col[k].abs();
        for (r, x) in col.iter().enumerate().skip(k + 1) {
            if x.abs() > best {
                best = x.abs();
                p = r;
            }
        }
        if best < 1e-300 || !best.is_finite() {
            return false;
        }
        piv[k] = p;
        if p != k {
            // Swap only the active columns: `lu_apply_colmajor` interleaves
            // the row swaps with forward elimination, so multipliers already
            // stored in columns < k must stay where they were computed.
            for c in k..n {
                a.swap(c * n + k, c * n + p);
            }
        }
        let inv = 1.0 / a[k * n + k];
        for r in k + 1..n {
            a[k * n + r] *= inv;
        }
        for c in k + 1..n {
            let akc = a[c * n + k];
            if akc == 0.0 {
                continue;
            }
            let (left, right) = a.split_at_mut(c * n);
            let mult = &left[k * n + k + 1..k * n + n];
            for (d, m) in right[k + 1..n].iter_mut().zip(mult) {
                *d -= m * akc;
            }
        }
    }
    true
}

/// Solve with factors from `lu_factor_colmajor`; `b` becomes the solution.
#[inline]
fn lu_apply_colmajor(a: &[f64], piv: &[usize], b: &mut [f64], n: usize) {
    for k in 0..n {
        let p = piv[k];
        if p != k {
            b.swap(k, p);
        }
        let bk = b[k];
        if bk != 0.0 {
            for (bb, &m) in b[k + 1..n].iter_mut().zip(&a[k * n + k + 1..k * n + n]) {
                *bb -= m * bk;
            }
        }
    }
    for k in (0..n).rev() {
        let x = b[k] / a[k * n + k];
        b[k] = x;
        for (bb, &ak) in b[..k].iter_mut().zip(&a[k * n..k * n + k]) {
            *bb -= ak * x;
        }
    }
}

pub struct Solver {
    circuit: Circuit,
    dt: f64,
    overrides: HashMap<String, f64>,
    reduced: Reduced,
    state: Vec<f64>,
    g: Vec<f64>,
    alpha: Vec<f64>,
    beta: Vec<f64>,
    newton: Newton,
    vst: Vec<f64>,
    dc_nodes: Vec<f64>,
    v_prev: Vec<f64>,
    u_prev: f64,
    y_prev: f64,
    /// Time-varying source voltages for the next step, the previous step's
    /// values (sub-steps interpolate between them) and scratch space.
    aux: Vec<f64>,
    aux_prev: Vec<f64>,
    aux_mid: Vec<f64>,
    /// Reduced systems at dt / 2^level for adaptive sub-stepping, built on
    /// first use and dropped when the knobs change.
    fine: Vec<Option<(Reduced, Vec<f64>)>>,
    save_v: Vec<f64>,
    save_state: Vec<f64>,
    save_vst: Vec<f64>,
    pub substeps: u64,

    pub failures: u64,
    pub iterations: u64,
    pub samples: u64,
}

impl Solver {
    pub fn new(circuit: Circuit, sample_rate: f64, overrides: HashMap<String, f64>) -> Result<Solver, String> {
        let dt = 1.0 / sample_rate;
        let reduced = reduce(&circuit, &overrides, Some(dt))?;
        let ns = circuit.reactives.len();
        let mut g = vec![0.0; ns];
        let mut alpha = vec![0.0; ns];
        let mut beta = vec![0.0; ns];
        for (k, x) in circuit.reactives.iter().enumerate() {
            g[k] = companion_g(x, dt);
            // h' = alpha * G * v + beta * h
            let (a, b) = match (x.inductor, x.method) {
                (false, Integrator::Trapezoidal) => (2.0, -1.0),
                (false, Integrator::BackwardEuler) => (1.0, 0.0),
                (true, Integrator::Trapezoidal) => (2.0, 1.0),
                (true, Integrator::BackwardEuler) => (1.0, 1.0),
            };
            alpha[k] = a;
            beta[k] = b;
        }
        let newton = Newton::new(&circuit);
        let mut solver = Solver {
            dt,
            overrides,
            reduced,
            state: vec![0.0; ns],
            g,
            alpha,
            beta,
            newton,
            vst: vec![0.0; ns],
            dc_nodes: Vec::new(),
            v_prev: Vec::new(),
            u_prev: 0.0,
            y_prev: 0.0,
            aux: circuit.aux_initial.clone(),
            aux_prev: circuit.aux_initial.clone(),
            aux_mid: circuit.aux_initial.clone(),
            fine: (0..=MAX_SUBSTEP_LEVEL).map(|_| None).collect(),
            save_v: vec![0.0; circuit.nv],
            save_state: vec![0.0; ns],
            save_vst: vec![0.0; ns],
            substeps: 0,

            failures: 0,
            iterations: 0,
            samples: 0,
            circuit,
        };
        solver.init_dc()?;
        solver.prepare_substeps();
        Ok(solver)
    }

    /// Change resistor values (pots, switches) keeping the reactive state.
    pub fn set_overrides(&mut self, overrides: HashMap<String, f64>) -> Result<(), String> {
        self.overrides = overrides;
        self.reduced = reduce(&self.circuit, &self.overrides, Some(self.dt))?;
        self.fine.iter_mut().for_each(|f| *f = None);
        self.newton.lu_valid = false;
        Ok(())
    }

    fn init_dc(&mut self) -> Result<(), String> {
        let dc = reduce(&self.circuit, &self.overrides, None)?;
        // Two-phase adaptive continuation. Phase 1 ramps the supplies with
        // op-amp output swings widened (so rails cannot trap the ramp);
        // phase 2 pulls the swings back to their real limits. A failed step
        // is retried from the last good point with half the increment.
        const WIDEN: f64 = 100.0;
        let wide = self.circuit.with_widened_opamps(WIDEN);
        let mut good = self.newton.v.clone();
        for phase in 0..2 {
            let mut t = 0.0f64;
            let mut h = 0.05f64;
            while t < 1.0 {
                let next = (t + h).min(1.0);
                let (lambda, widen) = if phase == 0 { (next, WIDEN) } else { (1.0, WIDEN * (1.0 - next)) };
                let circuit = if phase == 0 { &wide } else { &self.circuit };
                let staged;
                let circuit = if phase == 1 && widen > 0.0 {
                    staged = self.circuit.with_widened_opamps(widen);
                    &staged
                } else {
                    circuit
                };
                for r in 0..self.circuit.nv {
                    self.newton.p[r] = dc.mv_0[r];
                }
                dc.mv_a.mul_vec_add(&self.aux, &mut self.newton.p);
                self.newton.p.iter_mut().for_each(|p| *p *= lambda);
                self.newton.lu_valid = false;
                let (_, ok) = self.newton.solve(circuit, &dc.kt, 200, 1e-10);
                if ok {
                    good.copy_from_slice(&self.newton.v);
                    t = next;
                    h = (h * 1.5).min(0.25);
                } else {
                    self.newton.v.copy_from_slice(&good);
                    h *= 0.5;
                    if h < 1e-5 {
                        return Err("DC operating point did not converge".into());
                    }
                }
            }
        }
        // Currents at the final point with the real circuit.
        self.newton.eval_devices(&self.circuit);
        let mut vst = dc.mst_0.clone();
        dc.mst_a.mul_vec_add(&self.aux, &mut vst);
        dc.mst_i.mul_vec_add(&self.newton.i, &mut vst);
        // Full node voltages for diagnostics: x = A^-1 (b0 + Ni i).
        let a = self.circuit.matrix(&self.overrides, None);
        let lu = Lu::factor(&a).ok_or("singular DC matrix")?;
        let (_, bu, b0, ni) = self.circuit.rhs_parts();
        let mut rhs: Vec<f64> = (0..self.circuit.nx)
            .map(|r| b0.at(r, 0) + (0..self.aux.len()).map(|k| bu.at(r, 1 + k) * self.aux[k]).sum::<f64>())
            .collect();
        ni.mul_vec_add(&self.newton.i, &mut rhs);
        let mut x = vec![0.0; self.circuit.nx];
        lu.solve(&rhs, &mut x);
        self.dc_nodes = x[..self.circuit.node_names.len()].to_vec();
        self.v_prev = self.newton.v.clone();
        self.newton.lu_valid = false;
        for (k, x) in self.circuit.reactives.iter().enumerate() {
            self.state[k] = if x.inductor { 1e3 * vst[k] } else { self.g[k] * vst[k] };
            // Inductors carry their DC current in `state`; their voltage is 0.
            self.vst[k] = if x.inductor { 0.0 } else { vst[k] };
        }
        Ok(())
    }

    /// Set time-varying source `k` for the next `step` (volts).
    #[inline]
    pub fn set_aux(&mut self, k: usize, volts: f64) {
        self.aux[k] = volts;
    }

    pub fn aux_count(&self) -> usize {
        self.aux.len()
    }

    /// DC operating-point node voltages (indexed like `Circuit::node_names`).
    pub fn dc_nodes(&self) -> &[f64] {
        &self.dc_nodes
    }

    /// Node voltages are not tracked per sample; this reports the nonlinear
    /// port voltages for diagnostics.
    pub fn refactors(&self) -> u64 {
        self.newton.refactors
    }

    pub fn port_voltages(&self) -> &[f64] {
        &self.newton.v
    }

    /// Advance one sample with input voltage `u`; returns the output node voltage.
    ///
    /// Saturating high-gain loops (op-amps against their rails, discrete
    /// differential pairs) can defeat Newton at the audio step. Like SPICE's
    /// timestep control, a failed sample is re-integrated as 2, 4, ... 32
    /// sub-steps with linearly interpolated input before giving up.
    #[inline]
    pub fn step(&mut self, u: f64) -> f64 {
        self.samples += 1;
        let nv = self.circuit.nv;
        self.save_v.copy_from_slice(&self.newton.v);
        // Linear extrapolation of the port voltages as the Newton start.
        for k in 0..nv {
            let v = self.newton.v[k];
            self.newton.v[k] = 2.0 * v - self.v_prev[k];
        }
        let (mut y, mut ok, iters) = advance(
            &self.circuit, &mut self.newton, &self.reduced, &self.g, &self.alpha, &self.beta,
            &mut self.state, &mut self.vst, u, &self.aux, 12,
        );
        self.iterations += iters as u64;
        if !ok {
            // Restart from the last converged point with a fresh Jacobian.
            self.newton.v.copy_from_slice(&self.save_v);
            self.newton.lu_valid = false;
            let (y2, ok2, more) = advance(
                &self.circuit, &mut self.newton, &self.reduced, &self.g, &self.alpha, &self.beta,
                &mut self.state, &mut self.vst, u, &self.aux, 40,
            );
            self.iterations += more as u64;
            y = y2;
            ok = ok2;
        }
        if !ok {
            ok = false;
            for level in 1..=MAX_SUBSTEP_LEVEL {
                self.newton.v.copy_from_slice(&self.save_v);
                self.newton.lu_valid = false;
                if let Some(value) = self.substep(level, u) {
                    y = value;
                    ok = true;
                    break;
                }
            }
            if !ok {
                if DEBUG_NEWTON.load(std::sync::atomic::Ordering::Relaxed) && self.failures < 3 {
                    eprintln!("== sample {} failed at every sub-step level (u={u:.4}, u_prev={:.4})", self.samples, self.u_prev);
                }
                // Never commit an unconverged step: garbage currents would
                // charge capacitors to absurd voltages and every later sample
                // would fail too. Hold the state for this sample instead (a
                // one-sample freeze) and try again with the next input.
                self.failures += 1;
                self.newton.v.copy_from_slice(&self.save_v);
                self.newton.lu_valid = false;
                y = self.y_prev;
            }
        }
        self.v_prev.copy_from_slice(&self.save_v);
        self.u_prev = u;
        self.aux_prev.copy_from_slice(&self.aux);
        self.y_prev = y;
        y
    }

    /// Build the first sub-step levels ahead of time so the first hard
    /// sample does not pay for matrix construction on the audio thread.
    fn prepare_substeps(&mut self) {
        for level in 1..=2 {
            let dt = self.dt / (1u64 << level) as f64;
            if let Ok(reduced) = reduce(&self.circuit, &self.overrides, Some(dt)) {
                let g: Vec<f64> = self.circuit.reactives.iter().map(|x| companion_g(x, dt)).collect();
                self.fine[level] = Some((reduced, g));
            }
        }
    }

    /// Integrate the current sample as 2^level sub-steps. Leaves the solver
    /// untouched and returns None if any sub-step fails.
    fn substep(&mut self, level: usize, u: f64) -> Option<f64> {
        if self.fine[level].is_none() {
            let dt = self.dt / (1u64 << level) as f64;
            let reduced = reduce(&self.circuit, &self.overrides, Some(dt)).ok()?;
            let g: Vec<f64> = self.circuit.reactives.iter().map(|x| companion_g(x, dt)).collect();
            self.fine[level] = Some((reduced, g));
        }
        self.save_state.copy_from_slice(&self.state);
        self.save_vst.copy_from_slice(&self.vst);
        let (fine, g_fine) = self.fine[level].as_ref().unwrap();
        // Re-express history at the fine step via (voltage, current).
        for (k, x) in self.circuit.reactives.iter().enumerate() {
            let i = history_current(x, self.state[k], self.vst[k], self.g[k]);
            self.state[k] = history_from(x, self.vst[k], i, g_fine[k]);
        }
        let count = 1usize << level;
        let mut y = 0.0;
        for j in 1..=count {
            let frac = j as f64 / count as f64;
            let uj = self.u_prev + (u - self.u_prev) * frac;
            for k in 0..self.aux.len() {
                self.aux_mid[k] = self.aux_prev[k] + (self.aux[k] - self.aux_prev[k]) * frac;
            }
            let (yj, ok, iters) = advance(
                &self.circuit, &mut self.newton, fine, g_fine, &self.alpha, &self.beta,
                &mut self.state, &mut self.vst, uj, &self.aux_mid, 40,
            );
            self.iterations += iters as u64;
            if !ok {
                self.state.copy_from_slice(&self.save_state);
                self.vst.copy_from_slice(&self.save_vst);
                return None;
            }
            y = yj;
        }
        for (k, x) in self.circuit.reactives.iter().enumerate() {
            let i = history_current(x, self.state[k], self.vst[k], g_fine[k]);
            self.state[k] = history_from(x, self.vst[k], i, self.g[k]);
        }
        self.substeps += 1;
        Some(y)
    }
}

#[cfg(test)]
mod lu_tests {
    use super::*;

    fn check(a_colmajor: &[f64], b: &[f64]) {
        let n = b.len();
        let mut lu = a_colmajor.to_vec();
        let mut piv = vec![0usize; n];
        assert!(lu_factor_colmajor(&mut lu, &mut piv, n));
        let mut x = b.to_vec();
        lu_apply_colmajor(&lu, &piv, &mut x, n);
        for r in 0..n {
            let ax: f64 = (0..n).map(|c| a_colmajor[c * n + r] * x[c]).sum();
            assert!((ax - b[r]).abs() < 1e-9 * (1.0 + b[r].abs()), "row {r}: A x = {ax}, b = {}, x = {x:?}", b[r]);
        }
    }

    #[test]
    fn colmajor_lu_solves_pivoted_systems() {
        // Newton Jacobian from the RAT op-amp/clipper stage (column-major).
        let j = [-1.045389205927014, 28.010046317608598, 27.935023139990328, 0.0, -1.0, 0.0, 8.732859332591761e-5, 0.0, -1.7730921913652655];
        check(&j, &[0.00079, -0.49021, -0.45388]);
        check(&[2.0, 1.0, 1.0, 3.0], &[1.0, 2.0]);
        check(&[0.0, 1.0, 1.0, 0.0], &[3.0, 4.0]);
        check(&[1.0, 4.0, 7.0, 2.0, 5.0, 8.0, 3.0, 6.0, 10.0], &[1.0, 2.0, 3.0]);
    }
}
