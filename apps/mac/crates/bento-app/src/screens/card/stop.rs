//! What Stop does, as the console decides it (`stop-action.ts`), for the drawer and the Sessions
//! page alike.

use bento_client::{AgentEvent, MessageRole, TurnState};

/// Tools whose live session can stop a turn and keep the run open.
const INTERRUPTIBLE: &[&str] = &["claude-code", "codex", "opencode", "pi"];
/// How long Stop rests after an interrupt whose turn end never arrived.
pub const INTERRUPT_SETTLE: f64 = 15.0;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StopDoes {
    Interrupt,
    End,
    None,
}

/// Whether the agent is in a turn, and whether an interrupt is on its way.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Turn {
    /// As the server holding the run last said.
    pub said: Option<TurnState>,
    /// The same, read off the transcript until the server says.
    pub from_events: bool,
    /// An interrupt was sent and its turn has not ended; the clock time it was sent.
    pub interrupt_sent: Option<f64>,
}

impl Default for Turn {
    fn default() -> Self {
        Turn { said: None, from_events: true, interrupt_sent: None }
    }
}

impl Turn {
    pub fn on_event(&mut self, e: &AgentEvent) {
        match e {
            AgentEvent::Message { role: MessageRole::User, .. } => self.from_events = true,
            AgentEvent::Result { .. } => {
                self.from_events = false;
                self.interrupt_sent = None;
            }
            _ => {}
        }
    }

    pub fn on_turn(&mut self, turn: TurnState) {
        self.said = Some(turn);
        if turn == TurnState::Waiting {
            self.interrupt_sent = None;
        }
    }

    fn working(&self) -> bool {
        match self.said {
            Some(t) => t == TurnState::Working,
            None => self.from_events,
        }
    }

    /// Clears an interrupt that never heard back. Returns whether it did, and otherwise how long
    /// until it would.
    pub fn settle(&mut self, now: f64) -> (bool, Option<f64>) {
        match self.interrupt_sent {
            Some(sent) if now - sent >= INTERRUPT_SETTLE => {
                self.interrupt_sent = None;
                (true, None)
            }
            Some(sent) => (false, Some(INTERRUPT_SETTLE - (now - sent))),
            None => (false, None),
        }
    }
}

/// The newest run as Stop sees it.
pub struct RunFacts<'a> {
    pub active: bool,
    pub live_session: Option<bool>,
    pub role: Option<&'a str>,
    pub cli: Option<&'a str>,
}

pub fn stop_does(run: Option<RunFacts>, turn: &Turn) -> StopDoes {
    if turn.interrupt_sent.is_some() {
        return StopDoes::None;
    }
    let Some(run) = run.filter(|r| r.active) else { return StopDoes::None };
    let stage = run.role.is_none_or(|r| r == "stage");
    let tool = run.cli.is_some_and(|c| INTERRUPTIBLE.contains(&c));
    if !(run.live_session == Some(true) && stage && tool) {
        return StopDoes::End;
    }
    if turn.working() { StopDoes::Interrupt } else { StopDoes::None }
}

/// The button's tooltip.
pub fn stop_help(does: StopDoes, turn: &Turn) -> &'static str {
    match does {
        StopDoes::End => "Stop the agent",
        StopDoes::Interrupt => "Stop this turn. The agent waits for your next message.",
        StopDoes::None if turn.interrupt_sent.is_some() => "Stopping this turn.",
        StopDoes::None => "The agent is waiting for your next message.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(live: Option<bool>, role: Option<&'static str>, cli: &'static str) -> Option<RunFacts<'static>> {
        Some(RunFacts { active: true, live_session: live, role, cli: Some(cli) })
    }

    #[test]
    fn interrupts_a_working_live_stage_agent_and_ends_everything_else() {
        let mut t = Turn::default();
        assert_eq!(stop_does(run(Some(true), None, "claude-code"), &t), StopDoes::Interrupt);
        t.on_event(&AgentEvent::Result { ok: true, session_id: None, cost_usd: None, input_tokens: None, output_tokens: None, num_turns: None, error: None, interrupted: false });
        assert_eq!(stop_does(run(Some(true), None, "claude-code"), &t), StopDoes::None);
        t.on_turn(TurnState::Working);
        assert_eq!(stop_does(run(Some(true), Some("stage"), "codex"), &t), StopDoes::Interrupt);
        t.interrupt_sent = Some(1.0);
        assert_eq!(stop_does(run(Some(true), None, "claude-code"), &t), StopDoes::None);
        assert_eq!(t.settle(10.0), (false, Some(6.0)));
        assert_eq!(t.settle(16.0), (true, None));
        assert_eq!(stop_does(run(Some(true), None, "fake"), &t), StopDoes::End);
        assert_eq!(stop_does(run(Some(false), None, "claude-code"), &t), StopDoes::End);
        assert_eq!(stop_does(run(Some(true), Some("judge"), "claude-code"), &t), StopDoes::End);
        assert_eq!(stop_does(Some(RunFacts { active: false, live_session: Some(true), role: None, cli: Some("pi") }), &t), StopDoes::None);
        t.on_turn(TurnState::Waiting);
        assert_eq!(stop_help(stop_does(run(Some(true), None, "pi"), &t), &t), "The agent is waiting for your next message.");
    }
}
