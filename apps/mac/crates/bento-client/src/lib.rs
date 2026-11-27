//! A blocking client for the Bento server's HTTP API, for the Mac app.
//!
//! No async runtime: every call blocks the calling thread, so run them from
//! a worker pool. Streams (`Client::stream_board`, `Client::stream_run`) run
//! on a thread of their own and deliver through a callback or a channel.
//!
//! Local mode (`BENTO_MODE=local`) needs nothing on a request: the server
//! acts as its one local user and checks no session, origin or CSRF token.
//! A bearer token, when set, rides on every request for a hosted server.

mod api;
mod client;
mod error;
pub mod sse;
mod stream;
mod types;

pub use api::{analytics::*, artifacts::*, sessions::*, settings::*, swarms::*};
pub use client::Client;
pub use error::{Error, Result};
pub use stream::{BoardUpdate, RunUpdate, StreamHandle};
pub use types::*;
