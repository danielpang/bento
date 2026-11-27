//! One module per console page. Each adds `impl Client` methods with the helpers in
//! `client.rs` (`get`, `post`, `post_empty`, `request`, `send`, `decode`, `encode`) and, for
//! a stream, a `stream::Consumer` handed to `stream::spawn`.

pub mod analytics;
pub mod artifacts;
pub mod sessions;
pub mod settings;
pub mod swarms;
