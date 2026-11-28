//! Bento's tokens, from `apps/web/src/styles.css`, and the kit built on them.

use rune::color::Color;
use rune::{El, TextStyle, text};
use rune_kit::{Kit, PaletteSeed};

pub fn c(hex: u32) -> Color {
    let ch = |shift: u32| rune::color::srgb_decode(((hex >> shift) & 0xff) as f32 / 255.0);
    Color { r: ch(16), g: ch(8), b: ch(0), a: 1.0 }
}

pub struct Tokens {
    pub bg: Color,
    pub panel: Color,
    pub raised: Color,
    pub line: Color,
    pub text: Color,
    pub dim: Color,
    pub faint: Color,
    pub brand: Color,
    pub running: Color,
    pub succeeded: Color,
    pub failed: Color,
    pub gated: Color,
    pub idle: Color,
    pub on_brand: Color,
}

pub fn tokens(dark: bool) -> Tokens {
    if dark {
        Tokens {
            bg: c(0x0e0d0b),
            panel: c(0x161411),
            raised: c(0x1d1b17),
            line: c(0x2a2722),
            text: c(0xededed),
            dim: c(0xa8a49b),
            faint: c(0x8b867c),
            brand: c(0xff8a3d),
            running: c(0x4da3ff),
            succeeded: c(0x3fbf7f),
            failed: c(0xff6b5e),
            gated: c(0xf2c40d),
            idle: c(0x6d675c),
            on_brand: c(0x1c0e04),
        }
    } else {
        Tokens {
            bg: c(0xf2f1ed),
            panel: c(0xf9f8f5),
            raised: c(0xffffff),
            line: c(0xe2dfd8),
            text: c(0x1d1a14),
            dim: c(0x575145),
            faint: c(0x6b6455),
            brand: c(0xb34a00),
            running: c(0x0f62d6),
            succeeded: c(0x0d7a4a),
            failed: c(0xc22f21),
            gated: c(0x806000),
            idle: c(0x746d5f),
            on_brand: c(0x1c0e04),
        }
    }
}

pub fn kit(t: &Tokens) -> Kit {
    let mut k = Kit::from_palette(PaletteSeed { bg: t.bg, fg: t.text, accent: t.brand });
    k.radius.md = 7.0;
    k
}

pub fn label(s: impl Into<String>, size: f32, weight: f32, color: Color) -> El {
    text(s).font(TextStyle::new(size, weight)).color(color)
}

pub fn mono(s: impl Into<String>, size: f32, color: Color) -> El {
    text(s).font(TextStyle::new(size, 450.0).mono()).color(color)
}
