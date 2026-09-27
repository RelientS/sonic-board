//! Small dense linear algebra for circuit matrices (row-major).

#[derive(Clone, Debug)]
pub struct Mat {
    pub rows: usize,
    pub cols: usize,
    pub data: Vec<f64>,
}

impl Mat {
    pub fn zeros(rows: usize, cols: usize) -> Self {
        Self { rows, cols, data: vec![0.0; rows * cols] }
    }

    #[inline]
    pub fn at(&self, r: usize, c: usize) -> f64 {
        self.data[r * self.cols + c]
    }

    #[inline]
    pub fn set(&mut self, r: usize, c: usize, v: f64) {
        self.data[r * self.cols + c] = v;
    }

    #[inline]
    pub fn add(&mut self, r: usize, c: usize, v: f64) {
        self.data[r * self.cols + c] += v;
    }

    pub fn mul(&self, other: &Mat) -> Mat {
        assert_eq!(self.cols, other.rows);
        let mut out = Mat::zeros(self.rows, other.cols);
        for r in 0..self.rows {
            for k in 0..self.cols {
                let a = self.at(r, k);
                if a == 0.0 {
                    continue;
                }
                let row = &other.data[k * other.cols..(k + 1) * other.cols];
                let dst = &mut out.data[r * other.cols..(r + 1) * other.cols];
                for (d, b) in dst.iter_mut().zip(row) {
                    *d += a * b;
                }
            }
        }
        out
    }

    /// `out = self * v` (out is overwritten).
    #[inline]
    pub fn mul_vec_into(&self, v: &[f64], out: &mut [f64]) {
        for r in 0..self.rows {
            let row = &self.data[r * self.cols..(r + 1) * self.cols];
            let mut acc = 0.0;
            for (a, b) in row.iter().zip(v) {
                acc += a * b;
            }
            out[r] = acc;
        }
    }

    /// `out += self * v`.
    #[inline]
    pub fn mul_vec_add(&self, v: &[f64], out: &mut [f64]) {
        for r in 0..self.rows {
            let row = &self.data[r * self.cols..(r + 1) * self.cols];
            let mut acc = 0.0;
            for (a, b) in row.iter().zip(v) {
                acc += a * b;
            }
            out[r] += acc;
        }
    }
}

/// In-place LU with partial pivoting. Returns None when singular.
pub struct Lu {
    n: usize,
    lu: Vec<f64>,
    piv: Vec<usize>,
}

impl Lu {
    pub fn factor(m: &Mat) -> Option<Lu> {
        assert_eq!(m.rows, m.cols);
        let n = m.rows;
        let mut lu = m.data.clone();
        let mut piv: Vec<usize> = (0..n).collect();
        for k in 0..n {
            let mut p = k;
            let mut best = lu[k * n + k].abs();
            for r in k + 1..n {
                let v = lu[r * n + k].abs();
                if v > best {
                    best = v;
                    p = r;
                }
            }
            if best < 1e-300 || !best.is_finite() {
                return None;
            }
            if p != k {
                for c in 0..n {
                    lu.swap(k * n + c, p * n + c);
                }
                piv.swap(k, p);
            }
            let d = lu[k * n + k];
            for r in k + 1..n {
                let f = lu[r * n + k] / d;
                if f == 0.0 {
                    continue;
                }
                lu[r * n + k] = f;
                for c in k + 1..n {
                    lu[r * n + c] -= f * lu[k * n + c];
                }
            }
        }
        Some(Lu { n, lu, piv })
    }

    pub fn solve(&self, b: &[f64], x: &mut [f64]) {
        let n = self.n;
        for i in 0..n {
            x[i] = b[self.piv[i]];
        }
        for i in 0..n {
            let mut acc = x[i];
            for k in 0..i {
                acc -= self.lu[i * n + k] * x[k];
            }
            x[i] = acc;
        }
        for i in (0..n).rev() {
            let mut acc = x[i];
            for k in i + 1..n {
                acc -= self.lu[i * n + k] * x[k];
            }
            x[i] = acc / self.lu[i * n + i];
        }
    }

    /// Solve for every column of `b`.
    pub fn solve_mat(&self, b: &Mat) -> Mat {
        let mut out = Mat::zeros(b.rows, b.cols);
        let mut col = vec![0.0; b.rows];
        let mut x = vec![0.0; b.rows];
        for c in 0..b.cols {
            for r in 0..b.rows {
                col[r] = b.at(r, c);
            }
            self.solve(&col, &mut x);
            for r in 0..b.rows {
                out.set(r, c, x[r]);
            }
        }
        out
    }
}

/// Solve a small dense system in place (Gaussian elimination, partial pivot).
/// `a` is n×n row-major and is destroyed; `b` becomes the solution.
#[inline]
pub fn solve_small(a: &mut [f64], b: &mut [f64], n: usize) -> bool {
    for k in 0..n {
        let mut p = k;
        let mut best = a[k * n + k].abs();
        for r in k + 1..n {
            let v = a[r * n + k].abs();
            if v > best {
                best = v;
                p = r;
            }
        }
        if best < 1e-300 || !best.is_finite() {
            return false;
        }
        if p != k {
            for c in 0..n {
                a.swap(k * n + c, p * n + c);
            }
            b.swap(k, p);
        }
        let d = a[k * n + k];
        for r in k + 1..n {
            let f = a[r * n + k] / d;
            if f == 0.0 {
                continue;
            }
            for c in k + 1..n {
                a[r * n + c] -= f * a[k * n + c];
            }
            b[r] -= f * b[k];
        }
    }
    for i in (0..n).rev() {
        let mut acc = b[i];
        for k in i + 1..n {
            acc -= a[i * n + k] * b[k];
        }
        b[i] = acc / a[i * n + i];
    }
    true
}
