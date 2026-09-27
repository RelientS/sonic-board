//! SPICE-subset netlist parser.
//!
//! Circuit files are plain SPICE decks so the same source runs in ngspice (the
//! offline reference) and in the realtime solver. Realtime-only metadata lives
//! in `*@` comment directives, which ngspice ignores:
//!
//! ```text
//! *@name   Big Muff Pi (Ram's Head)
//! *@input  Vin                      input voltage source driven by audio
//! *@output out [gain]               output node and digital make-up gain
//! *@oversample 4
//! *@pot    NAME RA RB TOTAL TAPER   RA = lug1..wiper, RB = wiper..lug3 ('-' if absent)
//! *@control LABEL POT [POT...] [default=0.5] [invert]
//! *@opamp  SUBCKT gbw=3e6 slew=1.7e6 aol=1e5 vlo=1 vhi=8 rout=75
//! *@switch LABEL ELEMENT VALUE_OFF VALUE_ON [default=0]
//! ```

use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq)]
pub enum Kind {
    Resistor,
    Capacitor,
    Inductor,
    VSource,
    Vcvs { gain: f64 },
    Diode { model: String },
    Bjt { model: String },
    Jfet { model: String },
    OpAmp { model: String },
}

#[derive(Clone, Debug)]
pub struct Element {
    pub name: String,
    pub kind: Kind,
    /// Node names, in SPICE order for the element type.
    pub nodes: Vec<String>,
    pub value: f64,
}

#[derive(Clone, Debug, Default)]
pub struct DiodeModel {
    pub is: f64,
    pub n: f64,
    pub rs: f64,
}

#[derive(Clone, Debug, Default)]
pub struct BjtModel {
    pub pnp: bool,
    pub is: f64,
    pub bf: f64,
    pub br: f64,
    pub nf: f64,
    pub vaf: f64,
    pub rb: f64,
    pub re: f64,
    pub rc: f64,
}

#[derive(Clone, Debug, Default)]
pub struct JfetModel {
    pub pchannel: bool,
    pub vto: f64,
    pub beta: f64,
    pub lambda: f64,
    pub is: f64,
}

#[derive(Clone, Debug)]
pub struct OpAmpModel {
    pub gbw: f64,
    pub slew: f64,
    pub aol: f64,
    pub vlo: f64,
    pub vhi: f64,
    pub rout: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Taper {
    Linear,
    /// Audio (A) taper: 10% resistance at half rotation.
    Log,
    /// Reverse audio (C) taper.
    RevLog,
}

impl Taper {
    pub fn fraction(self, position: f64) -> f64 {
        let t = position.clamp(0.0, 1.0);
        // (81^t - 1) / 80 puts 10% at mid-rotation.
        match self {
            Taper::Linear => t,
            Taper::Log => (81f64.powf(t) - 1.0) / 80.0,
            Taper::RevLog => 1.0 - (81f64.powf(1.0 - t) - 1.0) / 80.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Pot {
    pub name: String,
    pub ra: Option<String>,
    pub rb: Option<String>,
    pub total: f64,
    pub taper: Taper,
}

#[derive(Clone, Debug)]
pub struct Control {
    pub label: String,
    pub pots: Vec<String>,
    pub default: f64,
    pub invert: bool,
}

#[derive(Clone, Debug)]
pub struct Switch {
    pub label: String,
    pub element: String,
    pub off: f64,
    pub on: f64,
    pub default: f64,
}

#[derive(Clone, Debug, Default)]
pub struct Netlist {
    pub title: String,
    pub name: String,
    pub elements: Vec<Element>,
    pub diode_models: HashMap<String, DiodeModel>,
    pub bjt_models: HashMap<String, BjtModel>,
    pub jfet_models: HashMap<String, JfetModel>,
    pub opamp_models: HashMap<String, OpAmpModel>,
    pub input: String,
    pub output: String,
    pub output_gain: f64,
    pub oversample: usize,
    pub pots: Vec<Pot>,
    pub controls: Vec<Control>,
    pub switches: Vec<Switch>,
}

pub fn parse_value(token: &str) -> Result<f64, String> {
    let t = token.trim().to_ascii_lowercase();
    let split = t
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+' || c == 'e'))
        .unwrap_or(t.len());
    // Handle exponent vs suffix ambiguity: "1e-3" is numeric, "1meg" has suffix.
    let (num, suffix) = t.split_at(split);
    let base: f64 = num.parse().map_err(|_| format!("bad number: {token}"))?;
    let mult = if suffix.starts_with("meg") {
        1e6
    } else if suffix.starts_with("mil") {
        25.4e-6
    } else {
        match suffix.chars().next() {
            None => 1.0,
            Some('t') => 1e12,
            Some('g') => 1e9,
            Some('k') => 1e3,
            Some('m') => 1e-3,
            Some('u') | Some('µ') => 1e-6,
            Some('n') => 1e-9,
            Some('p') => 1e-12,
            Some('f') => 1e-15,
            // Units such as "ohm", "v", "h" carry no multiplier.
            Some(_) => 1.0,
        }
    };
    Ok(base * mult)
}

fn kv_params(text: &str) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    let cleaned = text.replace(['(', ')', ','], " ");
    for part in cleaned.split_whitespace() {
        if let Some((k, v)) = part.split_once('=') {
            if let Ok(value) = parse_value(v) {
                out.insert(k.to_ascii_lowercase(), value);
            }
        }
    }
    out
}

pub fn is_ground(node: &str) -> bool {
    node == "0" || node.eq_ignore_ascii_case("gnd")
}

impl Netlist {
    pub fn parse(source: &str) -> Result<Netlist, String> {
        let mut net = Netlist { output_gain: 1.0, oversample: 1, ..Default::default() };
        let mut lines: Vec<String> = Vec::new();
        for (index, raw) in source.lines().enumerate() {
            let line = raw.trim_end();
            if index == 0 && !line.starts_with("*@") {
                net.title = line.trim_start_matches('*').trim().to_string();
                continue;
            }
            if let Some(rest) = line.trim_start().strip_prefix('+') {
                if let Some(last) = lines.last_mut() {
                    last.push(' ');
                    last.push_str(rest);
                }
                continue;
            }
            lines.push(line.trim().to_string());
        }

        for line in &lines {
            if line.is_empty() {
                continue;
            }
            if let Some(directive) = line.strip_prefix("*@") {
                net.directive(directive.trim())?;
                continue;
            }
            if line.starts_with('*') || line.starts_with(';') {
                continue;
            }
            let line = match line.find(';') {
                Some(pos) => &line[..pos],
                None => line.as_str(),
            };
            let lower = line.to_ascii_lowercase();
            if lower.starts_with(".model") {
                net.model(line)?;
                continue;
            }
            if lower.starts_with('.') {
                continue;
            }
            net.element(line)?;
        }

        if net.input.is_empty() || net.output.is_empty() {
            return Err("netlist needs *@input and *@output".into());
        }
        if net.name.is_empty() {
            net.name = net.title.clone();
        }
        net.check()?;
        Ok(net)
    }

    fn directive(&mut self, text: &str) -> Result<(), String> {
        let mut parts = text.split_whitespace();
        let Some(key) = parts.next() else { return Ok(()) };
        let rest: Vec<&str> = parts.collect();
        match key {
            "name" => self.name = rest.join(" "),
            "input" => self.input = rest.first().ok_or("input needs source")?.to_string(),
            "output" => {
                self.output = rest.first().ok_or("output needs node")?.to_string();
                if let Some(g) = rest.get(1) {
                    self.output_gain = parse_value(g)?;
                }
            }
            "oversample" => {
                self.oversample = rest.first().ok_or("oversample needs factor")?.parse().map_err(|_| "bad oversample")?;
            }
            "pot" => {
                if rest.len() < 5 {
                    return Err(format!("pot needs NAME RA RB TOTAL TAPER: {text}"));
                }
                let opt = |s: &str| if s == "-" { None } else { Some(s.to_string()) };
                let taper = match rest[4].to_ascii_lowercase().as_str() {
                    "lin" | "b" => Taper::Linear,
                    "log" | "a" => Taper::Log,
                    "revlog" | "c" => Taper::RevLog,
                    other => return Err(format!("unknown taper {other}")),
                };
                self.pots.push(Pot {
                    name: rest[0].to_string(),
                    ra: opt(rest[1]),
                    rb: opt(rest[2]),
                    total: parse_value(rest[3])?,
                    taper,
                });
            }
            "control" => {
                let label = rest.first().ok_or("control needs label")?.to_string();
                let mut control = Control { label, pots: vec![], default: 0.5, invert: false };
                for token in &rest[1..] {
                    if let Some(v) = token.strip_prefix("default=") {
                        control.default = parse_value(v)?;
                    } else if *token == "invert" {
                        control.invert = true;
                    } else {
                        control.pots.push(token.to_string());
                    }
                }
                self.controls.push(control);
            }
            "switch" => {
                if rest.len() < 4 {
                    return Err(format!("switch needs LABEL ELEMENT OFF ON: {text}"));
                }
                let mut default = 0.0;
                if let Some(v) = rest.get(4).and_then(|t| t.strip_prefix("default=")) {
                    default = parse_value(v)?;
                }
                self.switches.push(Switch {
                    label: rest[0].to_string(),
                    element: rest[1].to_string(),
                    off: parse_value(rest[2])?,
                    on: parse_value(rest[3])?,
                    default,
                });
            }
            "opamp" => {
                let name = rest.first().ok_or("opamp needs subckt name")?.to_ascii_lowercase();
                let p = kv_params(&rest[1..].join(" "));
                let get = |k: &str, d: f64| *p.get(k).unwrap_or(&d);
                self.opamp_models.insert(
                    name,
                    OpAmpModel {
                        gbw: get("gbw", 3e6),
                        slew: get("slew", 1e6),
                        aol: get("aol", 1e5),
                        vlo: get("vlo", 1.0),
                        vhi: get("vhi", 8.0),
                        rout: get("rout", 75.0),
                    },
                );
            }
            _ => {}
        }
        Ok(())
    }

    fn model(&mut self, line: &str) -> Result<(), String> {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() < 3 {
            return Err(format!("bad .model: {line}"));
        }
        let name = tokens[1].to_ascii_lowercase();
        let rest = tokens[2..].join(" ");
        let kind_end = rest.find(|c: char| c == '(' || c.is_whitespace()).unwrap_or(rest.len());
        let kind = rest[..kind_end].to_ascii_lowercase();
        let p = kv_params(&rest[kind_end..]);
        let get = |k: &str, d: f64| *p.get(k).unwrap_or(&d);
        match kind.as_str() {
            "d" => {
                self.diode_models.insert(name, DiodeModel { is: get("is", 1e-14), n: get("n", 1.0), rs: get("rs", 0.0) });
            }
            "npn" | "pnp" => {
                self.bjt_models.insert(
                    name,
                    BjtModel {
                        pnp: kind == "pnp",
                        is: get("is", 1e-16),
                        bf: get("bf", 100.0),
                        br: get("br", 1.0),
                        nf: get("nf", 1.0),
                        vaf: get("vaf", 0.0),
                        rb: get("rb", 0.0),
                        re: get("re", 0.0),
                        rc: get("rc", 0.0),
                    },
                );
            }
            "njf" | "pjf" => {
                self.jfet_models.insert(
                    name,
                    JfetModel {
                        pchannel: kind == "pjf",
                        vto: get("vto", -2.0),
                        beta: get("beta", 1e-4),
                        lambda: get("lambda", 0.0),
                        is: get("is", 1e-14),
                    },
                );
            }
            other => return Err(format!("unsupported model type {other}")),
        }
        Ok(())
    }

    fn element(&mut self, line: &str) -> Result<(), String> {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        let name = tokens[0].to_string();
        let first = name.chars().next().unwrap().to_ascii_lowercase();
        let need = |n: usize| {
            if tokens.len() < n {
                Err(format!("element {name} needs {n} fields: {line}"))
            } else {
                Ok(())
            }
        };
        let node = |i: usize| tokens[i].to_string();
        let el = match first {
            'r' | 'c' | 'l' => {
                need(4)?;
                let kind = match first {
                    'r' => Kind::Resistor,
                    'c' => Kind::Capacitor,
                    _ => Kind::Inductor,
                };
                Element { name, kind, nodes: vec![node(1), node(2)], value: parse_value(tokens[3])? }
            }
            'v' => {
                need(3)?;
                let mut value = 0.0;
                for t in &tokens[3..] {
                    if t.eq_ignore_ascii_case("dc") {
                        continue;
                    }
                    if let Ok(v) = parse_value(t) {
                        value = v;
                        break;
                    }
                    break;
                }
                Element { name, kind: Kind::VSource, nodes: vec![node(1), node(2)], value }
            }
            'e' => {
                need(6)?;
                let gain = parse_value(tokens[5])?;
                Element { name, kind: Kind::Vcvs { gain }, nodes: vec![node(1), node(2), node(3), node(4)], value: gain }
            }
            'd' => {
                need(4)?;
                Element { name, kind: Kind::Diode { model: tokens[3].to_ascii_lowercase() }, nodes: vec![node(1), node(2)], value: 0.0 }
            }
            'q' => {
                need(5)?;
                Element {
                    name,
                    kind: Kind::Bjt { model: tokens[4].to_ascii_lowercase() },
                    nodes: vec![node(1), node(2), node(3)],
                    value: 0.0,
                }
            }
            'j' => {
                need(5)?;
                Element {
                    name,
                    kind: Kind::Jfet { model: tokens[4].to_ascii_lowercase() },
                    nodes: vec![node(1), node(2), node(3)],
                    value: 0.0,
                }
            }
            'x' => {
                need(5)?;
                // X<name> in+ in- out <subckt>
                Element {
                    name,
                    kind: Kind::OpAmp { model: tokens[4].to_ascii_lowercase() },
                    nodes: vec![node(1), node(2), node(3)],
                    value: 0.0,
                }
            }
            _ => return Err(format!("unsupported element: {line}")),
        };
        self.elements.push(el);
        Ok(())
    }

    fn check(&self) -> Result<(), String> {
        for el in &self.elements {
            match &el.kind {
                Kind::Diode { model } if !self.diode_models.contains_key(model) => {
                    return Err(format!("{}: unknown diode model {model}", el.name))
                }
                Kind::Bjt { model } if !self.bjt_models.contains_key(model) => {
                    return Err(format!("{}: unknown BJT model {model}", el.name))
                }
                Kind::Jfet { model } if !self.jfet_models.contains_key(model) => {
                    return Err(format!("{}: unknown JFET model {model}", el.name))
                }
                Kind::OpAmp { model } if !self.opamp_models.contains_key(model) => {
                    return Err(format!("{}: unknown op-amp {model}", el.name))
                }
                _ => {}
            }
        }
        let find = |n: &str| self.elements.iter().any(|e| e.name.eq_ignore_ascii_case(n));
        if !find(&self.input) {
            return Err(format!("input source {} not found", self.input));
        }
        for pot in &self.pots {
            for r in [&pot.ra, &pot.rb].into_iter().flatten() {
                if !find(r) {
                    return Err(format!("pot {} references missing {r}", pot.name));
                }
            }
        }
        for control in &self.controls {
            for p in &control.pots {
                if !self.pots.iter().any(|pot| &pot.name == p) {
                    return Err(format!("control {} references missing pot {p}", control.label));
                }
            }
        }
        for sw in &self.switches {
            if !find(&sw.element) {
                return Err(format!("switch {} references missing {}", sw.label, sw.element));
            }
        }
        Ok(())
    }

    /// Resistances for every pot element at the given control positions
    /// (indexed like `controls`). Pot ends never go below 1 ohm.
    pub fn pot_values(&self, positions: &[f64]) -> Vec<(String, f64)> {
        let mut out = Vec::new();
        for (ci, control) in self.controls.iter().enumerate() {
            let mut pos = positions.get(ci).copied().unwrap_or(control.default).clamp(0.0, 1.0);
            if control.invert {
                pos = 1.0 - pos;
            }
            for pot_name in &control.pots {
                let pot = self.pots.iter().find(|p| &p.name == pot_name).unwrap();
                let f = pot.taper.fraction(pos);
                if let Some(ra) = &pot.ra {
                    out.push((ra.clone(), (pot.total * f).max(1.0)));
                }
                if let Some(rb) = &pot.rb {
                    out.push((rb.clone(), (pot.total * (1.0 - f)).max(1.0)));
                }
            }
        }
        out
    }

    pub fn switch_values(&self, states: &[f64]) -> Vec<(String, f64)> {
        self.switches
            .iter()
            .enumerate()
            .map(|(i, sw)| {
                let on = states.get(i).copied().unwrap_or(sw.default) >= 0.5;
                (sw.element.clone(), if on { sw.on } else { sw.off })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_values() {
        assert_eq!(parse_value("10k").unwrap(), 10e3);
        assert!((parse_value("4.7n").unwrap() - 4.7e-9).abs() < 1e-20);
        assert_eq!(parse_value("1meg").unwrap(), 1e6);
        assert_eq!(parse_value("1e-3").unwrap(), 1e-3);
        assert_eq!(parse_value("100").unwrap(), 100.0);
        assert!((parse_value("2.2u").unwrap() - 2.2e-6).abs() < 1e-18);
    }

    #[test]
    fn audio_taper_hits_ten_percent_at_half() {
        assert!((Taper::Log.fraction(0.5) - 0.1).abs() < 1e-9);
        assert!((Taper::RevLog.fraction(0.5) - 0.9).abs() < 1e-9);
        assert_eq!(Taper::Log.fraction(1.0), 1.0);
    }
}
