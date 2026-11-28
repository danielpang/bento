//! Runs against a real Bento server in local mode:
//!
//!     BENTO_TEST_URL=http://127.0.0.1:4400 cargo test -p bento-client --test live
//!
//! Each test creates its own project from a fresh `git init` checkout, so it
//! never touches existing boards. Moving a card into a stage starts that
//! stage's agent; the tests cancel whatever run they start.

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bento_client::*;

fn client() -> Option<Client> {
    match std::env::var("BENTO_TEST_URL") {
        Ok(url) if !url.trim().is_empty() => Some(Client::new(&url).expect("BENTO_TEST_URL is not a usable URL")),
        _ => {
            eprintln!("skipping: set BENTO_TEST_URL to a running Bento server in local mode to run this test");
            None
        }
    }
}

fn unique(label: &str) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    format!("{label}-{}-{nanos}-{n}", std::process::id())
}

fn temp_repo() -> PathBuf {
    let dir = std::env::temp_dir().join(unique("bento-client-repo"));
    std::fs::create_dir_all(&dir).unwrap();
    let git = |args: &[&str]| {
        let out = Command::new("git").args(args).current_dir(&dir).output().expect("git is installed");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "init"]);
    // macOS temp paths go through a symlink; the server stores what it resolves.
    dir.canonicalize().unwrap()
}

fn new_project(client: &Client) -> Project {
    let repo = temp_repo();
    client
        .create_project(&NewProject::local(unique("client test"), repo.to_str().unwrap()))
        .expect("create project")
}

/// Stops every active run on the card, so a test leaves no agent working.
fn cancel_active_runs(client: &Client, feature_id: &str) {
    for run in client.get_feature(feature_id).expect("get feature").runs {
        if run.status.is_active() {
            match client.cancel_run(&run.id) {
                Ok(r) => assert_eq!(r.status, RunStatus::Cancelled),
                // It finished between the read and the cancel.
                Err(e) if e.status() == Some(409) => {}
                Err(e) => panic!("cancel {}: {e}", run.id),
            }
        }
    }
}

fn recv_until<T>(rx: &Receiver<T>, within: Duration, mut wanted: impl FnMut(&T) -> bool) -> Option<T> {
    let deadline = Instant::now() + within;
    loop {
        let left = deadline.checked_duration_since(Instant::now())?;
        match rx.recv_timeout(left) {
            Ok(item) if wanted(&item) => return Some(item),
            Ok(_) => {}
            Err(_) => return None,
        }
    }
}

#[test]
fn health_reports_local_mode() {
    let Some(client) = client() else { return };
    let health = client.health().expect("health");
    assert!(health.ok);
    assert_eq!(health.mode, Mode::Local);
}

#[test]
fn create_project_seeds_a_pipeline_with_agents() {
    let Some(client) = client() else { return };
    let project = new_project(&client);
    assert!(client.list_projects().unwrap().iter().any(|p| p.id == project.id));
    assert_eq!(client.get_project(&project.id).unwrap().name, project.name);

    let pipeline = client.pipeline(&project.id).expect("pipeline");
    assert!(!pipeline.stages.is_empty());
    let positions: Vec<i64> = pipeline.stages.iter().map(|s| s.position).collect();
    assert!(positions.windows(2).all(|w| w[0] < w[1]), "lanes in order: {positions:?}");

    let profiles = client.profiles().expect("profiles");
    for stage in &pipeline.stages {
        if let Some(agent) = &stage.default_agent_profile_id {
            assert!(profiles.iter().any(|p| &p.id == agent), "stage {:?} names an agent the profiles list has", stage.name);
        }
    }
}

#[test]
fn create_project_refuses_a_missing_path() {
    let Some(client) = client() else { return };
    let err = client
        .create_project(&NewProject::local("nowhere", "/definitely/not/a/real/checkout"))
        .unwrap_err();
    assert_eq!(err.status(), Some(400), "{err:?}");
    let Error::Api { message, .. } = err else { unreachable!() };
    assert!(!message.starts_with('{'), "the sentence, not the envelope: {message}");
}

#[test]
fn card_lifecycle_on_the_board() {
    let Some(client) = client() else { return };
    let project = new_project(&client);
    let card = client
        .create_feature(&NewFeature::new(&project.id, "Lifecycle card").description("made by bento-client"))
        .expect("create card");
    assert_eq!(card.status, FeatureStatus::Backlog);

    let board = client.board(&project.id).expect("board");
    assert!(board.backlog().any(|f| f.id == card.id));
    assert!(!board.runs.contains_key(&card.id), "a new card has no run");

    let first = board.pipeline.stages[0].id.clone();
    let moved = client.move_feature(&card.id, Some(&first)).expect("move into the first stage");
    assert_eq!(moved.current_stage_id.as_deref(), Some(first.as_str()));
    assert!(matches!(moved.status, FeatureStatus::Active | FeatureStatus::Gated), "{:?}", moved.status);
    cancel_active_runs(&client, &card.id);

    let board = client.board(&project.id).unwrap();
    assert!(board.in_stage(&first).any(|f| f.id == card.id));

    let back = client.move_feature(&card.id, None).expect("move to the backlog");
    assert_eq!(back.current_stage_id, None);
    // The server leaves status "active" on a card moved back to the
    // backlog; the lane is decided by the missing stage, not the status.
    assert!(!back.status.is_finished(), "{:?}", back.status);
    assert!(client.board(&project.id).unwrap().backlog().any(|f| f.id == card.id));

    let finished = client.finish_feature(&card.id).expect("finish");
    assert_eq!(finished.status, FeatureStatus::Done);
    assert!(client.board(&project.id).unwrap().completed().any(|f| f.id == card.id));
}

#[test]
fn refusals_carry_the_servers_sentence() {
    let Some(client) = client() else { return };
    let err = client.get_feature("00000000-0000-0000-0000-000000000000").unwrap_err();
    assert!(err.is_not_found(), "{err:?}");
    let Error::Api { message, .. } = &err else { unreachable!() };
    assert_eq!(message, "not found");

    let project = new_project(&client);
    let card = client.create_feature(&NewFeature::new(&project.id, "Bad move")).unwrap();
    let err = client.move_feature(&card.id, Some("not-a-uuid")).unwrap_err();
    let Error::Api { status, message, .. } = &err else { panic!("{err:?}") };
    assert_eq!((*status, message.as_str()), (400, "stageId: Invalid uuid"));
}

#[test]
fn board_stream_sees_a_card_created_while_subscribed() {
    let Some(client) = client() else { return };
    let project = new_project(&client);
    let stages = client.pipeline(&project.id).unwrap().stages;
    let (handle, rx) = client.board_channel(&project.id).expect("subscribe");
    // The subscription is registered when the response starts; give the
    // request a moment to land before the change it should hear.
    std::thread::sleep(Duration::from_millis(500));

    let card = client.create_feature(&NewFeature::new(&project.id, "Streamed card")).unwrap();
    // A create emits no board event; the move that follows does.
    client.move_feature(&card.id, Some(&stages[0].id)).unwrap();

    let seen = recv_until(&rx, Duration::from_secs(15), |u| {
        matches!(u, BoardUpdate::Event(BoardEvent::FeatureUpdated { feature_id, .. }) if *feature_id == card.id)
    });
    cancel_active_runs(&client, &card.id);
    let Some(BoardUpdate::Event(BoardEvent::FeatureUpdated { project_id, current_stage_id, .. })) = seen else {
        panic!("no feature_updated for the new card");
    };
    assert_eq!(project_id, project.id);
    assert_eq!(current_stage_id, Some(Some(stages[0].id.clone())));
    handle.stop();
}

#[test]
fn dropping_a_stream_handle_stops_its_thread_promptly() {
    let Some(client) = client() else { return };
    let project = new_project(&client);
    let (handle, rx) = client.board_channel(&project.id).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let started = Instant::now();
    drop(handle);
    // The thread owns the sender, so the channel closes when it exits.
    loop {
        match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(_) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => panic!("stream thread still running 2s after drop"),
        }
    }
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn board_stream_for_an_unknown_project_ends_with_not_found() {
    let Some(client) = client() else { return };
    let (handle, rx) = client.board_channel("00000000-0000-0000-0000-000000000000").unwrap();
    match rx.recv_timeout(Duration::from_secs(10)) {
        Ok(BoardUpdate::Ended(e)) => assert!(e.is_not_found(), "{e:?}"),
        other => panic!("{other:?}"),
    }
    std::thread::sleep(Duration::from_millis(100));
    assert!(handle.is_finished());
}

#[test]
fn a_run_streams_to_its_end_and_lands_in_the_conversation() {
    let Some(client) = client() else { return };
    let project = new_project(&client);
    let pipeline = client.pipeline(&project.id).unwrap();
    let stage = pipeline.stages.iter().find(|s| s.default_agent_profile_id.is_some()).expect("a stage with an agent");
    let card = client.create_feature(&NewFeature::new(&project.id, "Run card")).unwrap();
    client.move_feature(&card.id, Some(&stage.id)).unwrap();

    // Entering the stage started its agent. Whatever the server can do with
    // it (no API key fails it at once; a working agent is cancelled below),
    // the stream must replay its lines in order and end with `done`.
    let run = client.get_feature(&card.id).unwrap().runs.into_iter().next().expect("moving into the stage started a run");
    let (_handle, rx) = client.run_channel(&run.id, 0).unwrap();
    std::thread::sleep(Duration::from_secs(2));
    if client.get_run(&run.id).unwrap().status.is_active() {
        client.cancel_run(&run.id).expect("cancel");
    }

    let mut seqs = Vec::new();
    let mut done = None;
    let deadline = Instant::now() + Duration::from_secs(60);
    while done.is_none() {
        let left = deadline.checked_duration_since(Instant::now()).expect("the run stream never said done");
        match rx.recv_timeout(left).expect("the run stream never said done") {
            RunUpdate::Event { seq, .. } => seqs.push(seq),
            RunUpdate::Done { status } => done = Some(status),
            RunUpdate::Ended(e) => panic!("stream ended: {e}"),
            _ => {}
        }
    }
    let status = done.unwrap();
    assert!(status.is_terminal(), "{status:?}");
    assert!(seqs.windows(2).all(|w| w[0] < w[1]), "{seqs:?}");

    let interrupt = client.interrupt_run(&run.id).unwrap_err();
    assert_eq!(interrupt.status(), Some(409));

    let conversation = client.conversation(&card.id).expect("conversation");
    let block = conversation.blocks.iter().find(|b| b.run_id == run.id).expect("the finished run is a block");
    assert_eq!(block.status, status);
    assert_eq!(block.events.len(), seqs.len());

    // Replaying from the last seq delivers nothing but the end.
    let last = *seqs.last().unwrap_or(&0);
    let (_h, rx) = client.run_channel(&run.id, last).unwrap();
    match rx.recv_timeout(Duration::from_secs(10)).unwrap() {
        RunUpdate::Done { status: again } => assert_eq!(again, status),
        other => panic!("expected only done, got {other:?}"),
    }
}

/// The `fake` agent ships with the server for tests: a shell script that
/// prints Claude style events, and with "SLOW" in its prompt lingers for
/// about thirty seconds. Profiles are not part of this client's surface,
/// so it is made with a plain request and removed afterwards.
struct FakeProfile {
    base: String,
    id: String,
}

impl FakeProfile {
    fn create(base: &str) -> Self {
        let request = serde_json::json!({ "name": unique("Fake agent"), "cli": "fake", "model": "fake-1" });
        let text = ureq::post(&format!("{base}/api/profiles"))
            .set("content-type", "application/json")
            .send_string(&request.to_string())
            .expect("create a fake profile")
            .into_string()
            .unwrap();
        let body: serde_json::Value = serde_json::from_str(&text).unwrap();
        Self { base: base.to_owned(), id: body["id"].as_str().unwrap().to_owned() }
    }
}

impl Drop for FakeProfile {
    fn drop(&mut self) {
        let _ = ureq::delete(&format!("{}/api/profiles/{}", self.base, self.id)).call();
    }
}

fn wait_idle(client: &Client, feature_id: &str) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while client.get_feature(feature_id).unwrap().runs.iter().any(|r| r.status.is_active()) {
        assert!(Instant::now() < deadline, "the card's run never finished");
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[test]
fn a_live_run_streams_typing_and_can_be_cancelled() {
    let Some(client) = client() else { return };
    let fake = FakeProfile::create(client.base_url());
    let project = new_project(&client);
    let stage = client.pipeline(&project.id).unwrap().stages[0].clone();
    let card = client.create_feature(&NewFeature::new(&project.id, "Fake run card")).unwrap();
    client.move_feature(&card.id, Some(&stage.id)).unwrap();
    // The stage's own agent starts on entry; let it finish or stop it.
    cancel_active_runs(&client, &card.id);
    wait_idle(&client, &card.id);

    let run = client
        .start_run(&StartRun {
            feature_id: card.id.clone(),
            agent_profile_id: fake.id.clone(),
            stage_id: None,
            prompt: Some("SLOW".into()),
        })
        .expect("start a run");
    assert_eq!(run.stage_id.as_deref(), Some(stage.id.as_str()));

    let busy = client
        .start_run(&StartRun { feature_id: card.id.clone(), agent_profile_id: fake.id.clone(), stage_id: None, prompt: None })
        .unwrap_err();
    assert_eq!(busy.status(), Some(409), "one card, one agent: {busy:?}");

    let (handle, rx) = client.run_channel(&run.id, 0).unwrap();
    let typed = recv_until(&rx, Duration::from_secs(30), |u| matches!(u, RunUpdate::Delta(_)));
    assert!(matches!(typed, Some(RunUpdate::Delta(ref d)) if d.channel == "text"), "{typed:?}");

    let cancelled = client.cancel_run(&run.id).expect("cancel");
    assert_eq!(cancelled.status, RunStatus::Cancelled);
    let done = recv_until(&rx, Duration::from_secs(30), |u| matches!(u, RunUpdate::Done { .. }));
    assert!(matches!(done, Some(RunUpdate::Done { status: RunStatus::Cancelled })), "{done:?}");
    std::thread::sleep(Duration::from_millis(100));
    assert!(handle.is_finished(), "a done frame ends the stream thread");

    // An idle card hears a message as a new run on the latest session.
    wait_idle(&client, &card.id);
    let sent = client.message_feature(&card.id, "and one more thing").expect("message");
    assert!(!sent.queued);
    let follow_up = sent.run.expect("the message started a run");
    cancel_active_runs(&client, &card.id);
    wait_idle(&client, &card.id);
    let conversation = client.conversation(&card.id).unwrap();
    assert!(conversation.blocks.iter().any(|b| b.run_id == run.id && b.status == RunStatus::Cancelled));
    assert!(conversation.blocks.iter().any(|b| b.run_id == follow_up.id));
}
