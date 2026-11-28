//! Liquid metal. Every `El::effect` slot becomes one rune-fx fill: the mark says which
//! material, `effect_data` is `[border width, flow, 0, 0]` (border 0 fills the face).

use rune::compose::{Compositor, DeviceKey, Frame};
use rune::render::{EffectPhase, EffectSite, KIND_EFFECT};
use rune::{El, effect};
use rune_fx::*;

use crate::state::State;

pub const CHROME: u32 = 1;
pub const GOLD: u32 = 2;
pub const COPPER: u32 = 3;
pub const GUNMETAL: u32 = 4;
/// The primary action's face: a domed copper key that text stays readable on.
pub const KEY: u32 = 5;
pub const KEY_GOLD: u32 = 6;

/// A tube border around the parent, `width` points wide. `flow` 0 holds still.
pub fn ring(kind: u32, width: f32, flow: f32, radius: f32) -> El {
    effect(kind).effect_data([width, flow, 0.0, 0.0]).absolute(0.0, 0.0).w_full().h_full().radius(radius)
}

/// A filled face the size of its parent.
pub fn face(kind: u32, flow: f32, radius: f32) -> El {
    ring(kind, 0.0, flow, radius)
}

/// A small sphere: an agent's presence.
pub fn orb(kind: u32, flow: f32, size: f32) -> El {
    effect(kind).effect_data([0.0, flow, 0.0, 0.0]).size(size, size).radius(size / 2.0)
}

fn layer(kind: u32, d: [f32; 4], shape: Shape, t: f32) -> Option<(FxLayer, bool)> {
    let metal = |p: LiquidMetalParams| {
        let p = LiquidMetalParams { flow: p.flow * d[1], bevel: if d[0] > 0.0 { p.bevel } else { 5.0 }, ..p };
        let fx = if d[0] > 0.0 { Fx::fill(p.border(d[0])) } else { Fx::fill(p) };
        Some((fx.on(shape).at(t), d[1] > 0.0))
    };
    match kind {
        CHROME => metal(LiquidMetalParams::chrome()),
        GOLD => metal(LiquidMetalParams::gold()),
        COPPER => metal(LiquidMetalParams { tint: rgb(0xff8a3d), light: rgb(0xfff1e2), iridescence: 0.0, ..LiquidMetalParams::chrome() }),
        GUNMETAL => metal(LiquidMetalParams::gunmetal()),
        KEY => Some((Fx::fill(PlasticParams { color: rgb(0xff8a3d), roughness: 0.3, dome: 0.3, bevel: 4.0, angle: -0.5 }).on(shape).at(t), false)),
        KEY_GOLD => Some((Fx::fill(PlasticParams { color: rgb(0xf2c40d), roughness: 0.3, dome: 0.3, bevel: 4.0, angle: -0.5 }).on(shape).at(t), false)),
        _ => None,
    }
}

struct Cache {
    device_key: DeviceKey,
    format: wgpu::TextureFormat,
    fx: FxRenderer,
}

pub struct Metal {
    cache: Option<Cache>,
    flowing: bool,
}

impl Default for Metal {
    fn default() -> Self {
        Metal { cache: None, flowing: true }
    }
}

impl Compositor<State> for Metal {
    fn animating(&self) -> bool {
        self.flowing
    }

    fn release_gpu(&mut self) {
        self.cache = None;
    }

    fn render(&mut self, f: &mut Frame<'_, State>) {
        let (device, queue, size) = (f.device, f.queue, f.size);
        let t = f.rt.t as f32;
        let marks = &f.rt.marks;
        let mut at: Vec<u32> = Vec::new();
        let mut layers: Vec<FxLayer> = Vec::new();
        let mut slots: Vec<FxSlot> = Vec::new();
        let mut flowing = false;
        for (n, i) in f.rt.instances.iter().enumerate() {
            if i.params[1] != KIND_EFFECT {
                continue;
            }
            let kind = marks.get(n).copied().unwrap_or(0) & 0xff;
            let k = i.params[3];
            let [x, y, w, h] = i.rect.map(|v| v / k);
            let r = i.radii.iter().fold(0.0f32, |a, v| a.max(v.abs())) / k;
            let Some((l, flows)) = layer(kind, i.uv, Shape::rounded(x, y, w, h, r), t) else { continue };
            flowing |= flows;
            at.push(n as u32);
            layers.push(l);
            slots.push(FxSlot::default().scale(k).clip(i.clip, i.fade));
        }
        self.flowing = flowing;
        let device_key = f.device_key();
        if self.cache.as_ref().is_none_or(|c| c.device_key != device_key || c.format != f.format) {
            self.cache = None;
            let mut fx = FxRenderer::new(device, f.format, FxOptions { dither: true });
            fx.add_format(device, wgpu::TextureFormat::Rgba16Float);
            self.cache = Some(Cache { device_key, format: f.format, fx });
        }
        let fx = &mut self.cache.as_mut().unwrap().fx;
        fx.set_srgb_blend(f.srgb_blend());
        fx.prepare_with_slots(device, queue, &FxFrame { viewport: [size.0, size.1], scale: 1.0, layers: &layers, backdrop: None, sources: &[] }, &slots);
        let clear = f.rt.clear_color();
        f.ui.prepare(device, queue, &mut f.rt.text.atlas, &f.rt.instances, size);
        f.ui.draw_with_backdrop(f.encoder, f.target, clear, &mut |phase, s: &EffectSite<'_>| {
            let Some(k) = at.iter().position(|n| *n == s.index) else { return };
            if let EffectPhase::Draw(pass) = phase {
                fx.draw_layer_in(pass, s.format, s.origin, k);
            }
        });
    }
}
