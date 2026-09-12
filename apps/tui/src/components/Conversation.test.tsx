import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import type { AgentProfile, AgentRun, BentoClient, Feature, RunArtifact, Stage } from "@bento/api-client";
import { MouseProvider } from "../mouse.js";
import { Conversation } from "./Conversation.js";
import {
  artifactStages,
  conversationEvent,
  conversationLines,
  wrapConversationText,
} from "./conversation-layout.js";

const pause = () => new Promise((resolve) => setTimeout(resolve, 160));
async function ready(ui: ReturnType<typeof render>, text: string) {
  const end = Date.now() + 5000;
  while (!ui.lastFrame()?.includes(text)) {
    if (Date.now() > end) throw new Error(`Missing ${text}: ${ui.lastFrame()}`);
    await pause();
  }
  await pause();
}
const feature = {
  id: "card",
  projectId: "project",
  currentStageId: "build",
  title: "Improve checkout",
  description: "Keep checkout accessible",
  status: "active",
} as Feature;

test("composer keeps terminal paste and removes bespoke clipboard and attachment controls", async () => {
  const f = fixture();
  const ui = render(
    <Conversation
      client={f.client}
      feature={feature}
      stages={stages}
      profiles={profiles}
      allowAttachments
      onClose={() => {}}
      onArtifacts={() => {}}
      initialView={{ following: true, offset: 0, tools: false, messageText: "Unsent draft" }}
    />,
  );
  try {
    await ready(ui, "Waiting for agent output");
    assert.doesNotMatch(
      ui.lastFrame()!,
      /\[(?:Copy chat|Copy draft|Paste|Attach|Tools)\]|Ctrl\+V|Ctrl\+O|y copy chat/,
    );
    ui.stdin.write("y");
    ui.stdin.write("\x0f");
    await pause();
    assert.match(ui.lastFrame()!, /Unsent draft/);
    assert.doesNotMatch(ui.lastFrame()!, /choose a message|Attach a file/);
    ui.stdin.write("c");
    await ready(ui, "Reply to agent");
    ui.stdin.write("\x1b[200~\nPasted café 🙂\nSecond line\x1b[201~");
    await ready(ui, "Second line");
    assert.match(ui.lastFrame()!, /Unsent draft/);
    assert.match(ui.lastFrame()!, /Pasted café 🙂/);
    assert.match(ui.lastFrame()!, /Waiting for agent output/);
    assert.doesNotMatch(ui.lastFrame()!, /Sent|Queued for agent/);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});
const stages = [
  { id: "plan", slug: "plan", name: "Plan" },
  { id: "build", slug: "build", name: "Build" },
] as Stage[];
const profiles = [{ id: "agent", name: "Software Engineer" }] as AgentProfile[];
const active = {
  id: "run",
  stageId: "build",
  agentProfileId: "agent",
  status: "running",
  queuedAt: new Date().toISOString(),
} as AgentRun;
function fixture() {
  let board = () => {};
  let stream: Parameters<BentoClient["streamRun"]>[1] | undefined;
  let subscriptions = 0,
    stops = 0,
    finished = false,
    cancelled = false,
    cancellations = 0;
  const client = {
    getConversation: async () => ({
      blocks: finished || cancelled
        ? [
            {
              runId: active.id,
              agentName: "Software Engineer",
              status: cancelled ? "cancelled" : "succeeded",
              queuedAt: active.queuedAt,
              events: finished ? [{ type: "message", role: "assistant", text: "Final response" }] : [],
            },
          ]
        : [],
      pending: [],
    }),
    getFeature: async () => ({
      ...feature,
      runs: [{ ...active, status: cancelled ? "cancelled" : finished ? "succeeded" : "running" }],
    }),
    cancelRun: async (id: string) => {
      assert.equal(id, active.id);
      cancellations++;
      cancelled = true;
      return { ...active, status: "cancelled" };
    },
    listArtifacts: async () => [],
    streamBoard: (_id: string, refresh: () => void) => {
      board = refresh;
      return () => {};
    },
    streamRun: (_id: string, handlers: Parameters<BentoClient["streamRun"]>[1], since: number) => {
      assert.equal(since, 0, "structured replay includes the existing messages");
      subscriptions++;
      stream = handlers;
      return () => {
        stops++;
      };
    },
  } as unknown as BentoClient;
  return {
    client,
    board: () => board(),
    stream: () => stream!,
    count: () => subscriptions,
    stops: () => stops,
    cancellations: () => cancellations,
    finish: () => {
      finished = true;
      stream!.onDone?.();
    },
  };
}

test("active conversation has a Stop button and x stops the agent", async () => {
  const f = fixture();
  const ui = render(
    <Conversation
      client={f.client}
      feature={feature}
      stages={stages}
      profiles={profiles}
      onClose={() => {}}
      onArtifacts={() => {}}
    />,
  );
  try {
    await ready(ui, "Waiting for agent output");
    assert.match(ui.lastFrame()!, /\[Stop\]/);
    assert.match(ui.lastFrame()!, /x stop/);
    ui.stdin.write("x");
    await ready(ui, "Stopped the agent.");
    assert.equal(f.cancellations(), 1);
    assert.doesNotMatch(ui.lastFrame()!, /\[Stop\]/);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("conversation Stop button stops the active agent", async () => {
  const f = fixture();
  const ui = render(
    <MouseProvider enabled>
      <Conversation
        client={f.client}
        feature={feature}
        stages={stages}
        profiles={profiles}
        onClose={() => {}}
        onArtifacts={() => {}}
      />
    </MouseProvider>,
  );
  try {
    await ready(ui, "Waiting for agent output");
    const lines = ui.lastFrame()!.split("\n");
    const y = lines.findIndex((line) => line.includes("[Stop]"));
    assert.ok(y >= 0, "Stop button is visible");
    const x = lines[y]!.indexOf("Stop");
    ui.stdin.write(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`);
    await ready(ui, "Stopped the agent.");
    assert.equal(f.cancellations(), 1);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("conversation keeps roles, tool details and terminal escape protection", () => {
  const messages = [
    ...conversationEvent({ type: "message", role: "user", text: "Please check café 🙂" }, "Engineer"),
    ...conversationEvent(
      { type: "tool", name: "Read", phase: "end", detail: { path: "src/payment.ts" } },
      "Engineer",
    ),
    ...conversationEvent(
      {
        type: "message",
        role: "assistant",
        text: "# Result\nSafe\x1b[2J\x1b]52;c;ZXZpbA==\x07text\n" + "long paragraph ".repeat(12),
      },
      "Engineer",
    ),
  ];
  const compact = conversationLines(messages, 32, false);
  assert.ok(compact.some((line) => line.text === "╭ You" && line.color === "cyan"));
  assert.ok(compact.some((line) => line.text === "╭ Engineer" && line.color === "magenta"));
  assert.ok(compact.some((line) => line.text === "│ Result" && line.bold));
  assert.match(compact.map((line) => line.text).join("\n"), /Safetext/);
  assert.doesNotMatch(compact.map((line) => line.text).join("\n"), /payment.ts|\x1b/);
  assert.match(
    conversationLines(messages, 32, true)
      .map((line) => line.text)
      .join("\n"),
    /payment.ts/,
  );
});

test("artifact groups include empty stages and artifacts from removed stages", () => {
  const items = [
    { id: "a", stageSlug: "build", stageName: "Build" },
    { id: "b", stageSlug: "old", stageName: "Earlier review" },
  ] as RunArtifact[];
  const groups = artifactStages(items, stages);
  assert.deepEqual(
    groups.map((group) => [group.slug, group.artifacts.length]),
    [
      ["plan", 0],
      ["build", 1],
      ["old", 1],
    ],
  );
});

test("live conversation keeps one stream through refresh, replaces drafts and exposes artifacts", async () => {
  const f = fixture();
  let opened = "";
  const ui = render(
    <Conversation
      client={f.client}
      feature={feature}
      stages={stages}
      profiles={profiles}
      onClose={() => {}}
      onArtifacts={(slug) => {
        opened = slug ?? "all";
      }}
    />,
  );
  try {
    await ready(ui, "Waiting for agent output");
    f.stream().onEvent?.({ type: "message", role: "user", text: "Make the button clearer" });
    f.stream().onDelta?.({ channel: "text", offset: 0, text: "Writing a response" });
    await ready(ui, "Writing a response");
    f.board();
    await pause();
    await pause();
    assert.equal(f.count(), 1, "board updates must not replay the active run again");
    f.stream().onEvent?.({ type: "message", role: "assistant", text: "Final response" });
    await ready(ui, "Final response");
    assert.doesNotMatch(ui.lastFrame()!, /Writing a response/);
    ui.stdin.write("a");
    await pause();
    assert.equal(opened, "all");
    ui.stdin.write("c");
    await pause();
    assert.match(ui.lastFrame()!, /Reply to agent/);
    assert.match(ui.lastFrame()!, /Final response/);
    f.finish();
    await ready(ui, "Latest messages");
    assert.equal(f.stops(), 1);
    assert.equal(ui.lastFrame()!.split("Final response").length - 1, 1);
    assert.match(ui.lastFrame()!, /Software Engineer/);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("history scrolling pauses follow and removed search keys leave the conversation unchanged", async () => {
  const f = fixture();
  let opened = 0;
  const ui = render(
    <Conversation
      client={f.client}
      feature={feature}
      stages={stages}
      profiles={profiles}
      onClose={() => {}}
      onArtifacts={() => opened++}
    />,
  );
  try {
    await ready(ui, "Waiting for agent output");
    f.stream().onEvent?.({
      type: "message",
      role: "assistant",
      text: Array.from({ length: 60 }, (_, i) => `Searchable line ${i}`).join("\n"),
    });
    await ready(ui, "Searchable line 59");
    ui.stdin.write("g");
    await ready(ui, "Card brief");
    f.stream().onDelta?.({ channel: "text", offset: 0, text: "New live content" });
    await pause();
    assert.doesNotMatch(ui.lastFrame()!, /New live content/);
    ui.stdin.write("/");
    ui.stdin.write("n");
    await pause();
    assert.match(ui.lastFrame()!, /Card brief/);
    assert.doesNotMatch(ui.lastFrame()!, /Find in conversation|\/ find/);
    assert.equal(opened, 0);
    ui.stdin.write("G");
    await ready(ui, "New live content");
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("artifact loading failure does not hide the conversation", async () => {
  const f = fixture();
  f.client.listArtifacts = async () => {
    throw new Error("offline");
  };
  const ui = render(
    <Conversation
      client={f.client}
      feature={feature}
      stages={stages}
      profiles={profiles}
      onClose={() => {}}
      onArtifacts={() => {}}
    />,
  );
  try {
    await ready(ui, "Waiting for agent output");
    assert.match(ui.lastFrame()!, /\[Artifacts\]/);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("conversation wrapping preserves words, Unicode graphemes and all text", () => {
  assert.deepEqual(wrapConversationText(["The summary stays visible while you work."], 26), [
    "The summary stays visible ",
    "while you work.",
  ]);
  const input = "你好 café 👩‍💻 ".repeat(20);
  assert.equal(wrapConversationText([input], 25).join(""), input);
  assert.ok(wrapConversationText([input], 25).every((line) => !line.startsWith("\u200d")));
});

test("inline composer preserves history and multiline drafts, and retries failed sends once", async () => {
  const f = fixture();
  const sent: { id: string; text: string }[] = [];
  let rejectSend: (error: Error) => void = () => {};
  let first = true;
  f.client.messageFeature = async (id, text) => {
    sent.push({ id, text });
    if (first) {
      first = false;
      return new Promise((_resolve, reject) => {
        rejectSend = reject;
      });
    }
    return { queued: true };
  };
  const ui = render(
    <Conversation
      client={f.client}
      feature={feature}
      stages={stages}
      profiles={profiles}
      onClose={() => {}}
      onArtifacts={() => {}}
      initialCompose
      onMessageSent={async () => {
        throw new Error("board refresh failed");
      }}
    />,
  );
  try {
    await ready(ui, "Reply to agent");
    f.stream().onEvent?.({ type: "message", role: "assistant", text: "Previous agent reply stays visible" });
    await ready(ui, "Previous agent reply stays visible");
    ui.stdin.write("\x1b[200~First line\nSecond line: café 🙂\x1b[201~");
    await ready(ui, "Second line: café 🙂");
    assert.equal(sent.length, 0, "pasting never sends");
    assert.match(ui.lastFrame()!, /Previous agent reply stays visible/);
    ui.stdin.write("\t");
    await pause();
    assert.match(ui.lastFrame()!, /Second line: café 🙂/);
    ui.stdin.write("c");
    await pause();
    ui.stdin.write("\r");
    ui.stdin.write("\r");
    await ready(ui, "Sending…");
    assert.equal(sent.length, 1, "only one request while sending");
    rejectSend(new Error("Connection failed. Retry."));
    await ready(ui, "Connection failed. Retry.");
    assert.match(ui.lastFrame()!, /Second line: café 🙂/);
    ui.stdin.write("\r");
    await ready(ui, "Queued.");
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1], { id: feature.id, text: "First line\nSecond line: café 🙂" });
    assert.doesNotMatch(ui.lastFrame()!, /Connection failed|Second line/);
    assert.match(ui.lastFrame()!, /Previous agent reply stays visible/);
    ui.stdin.write("\r");
    await pause();
    assert.equal(sent.length, 2, "empty draft cannot resend");
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("conversation shortcuts are ordinary text while composing and draft survives artifact navigation", async () => {
  const f = fixture();
  let opened = 0,
    closed = 0;
  let view: import("./Conversation.js").ConversationViewState | undefined;
  const props = {
    client: f.client,
    feature,
    stages,
    profiles,
    onClose: () => {
      closed++;
    },
    onArtifacts: () => {
      opened++;
    },
    onViewChange: (next: import("./Conversation.js").ConversationViewState) => {
      view = next;
    },
  };
  const ui = render(<Conversation {...props} initialCompose />);
  try {
    await ready(ui, "Reply to agent");
    ui.stdin.write("a c q x / t g G");
    await ready(ui, "a c q x / t g G");
    assert.equal(opened, 0);
    assert.equal(closed, 0);
    ui.stdin.write("\x1b");
    await pause();
    assert.match(ui.lastFrame()!, /a c q x \/ t g G/);
    ui.stdin.write("a");
    await pause();
    assert.equal(opened, 1);
    const saved = view;
    assert.equal(saved?.messageText, "a c q x / t g G");
    ui.unmount();
    ui.cleanup();
    const restored = render(<Conversation {...props} initialView={saved} />);
    try {
      await ready(restored, "a c q x / t g G");
    } finally {
      restored.unmount();
      restored.cleanup();
    }
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("pasted file paths become removable attachments and attachment-only sends include their bytes", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const folder = await mkdtemp("/tmp/bento-composer-file-");
  const file = folder + "/a picture.png";
  const bytes = Buffer.from([137, 80, 78, 71, 0, 255]);
  await writeFile(file, bytes);
  const f = fixture();
  const sent: unknown[] = [];
  f.client.messageFeature = async (id, text, attachments) => {
    sent.push({ id, text, attachments });
    return { queued: true };
  };
  const ui = render(
    <Conversation
      client={f.client}
      feature={feature}
      stages={stages}
      profiles={profiles}
      onClose={() => {}}
      onArtifacts={() => {}}
      initialCompose
      allowAttachments
    />,
  );
  try {
    await ready(ui, "Reply to agent");
    ui.stdin.write(`\x1b[200~'${file}'\x1b[201~`);
    await ready(ui, "a picture.png");
    assert.match(ui.lastFrame()!, /\[Remove\]/);
    assert.equal(sent.length, 0);
    ui.stdin.write("\r");
    await ready(ui, "Queued.");
    assert.deepEqual(sent, [
      {
        id: feature.id,
        text: "",
        attachments: [{ name: "a picture.png", mime: "image/png", data: bytes.toString("base64") }],
      },
    ]);
    assert.doesNotMatch(ui.lastFrame()!, /a picture.png/);
    ui.stdin.write("\x1b[200~/not-a-real-file\x1b[201~");
    await ready(ui, "/not-a-real-file");
    assert.doesNotMatch(ui.lastFrame()!, /\[Remove\]/);
  } finally {
    ui.unmount();
    ui.cleanup();
    await rm(folder, { recursive: true, force: true });
  }
});

test("tool inspector follows a live result and returns to the same unsent conversation draft", async () => {
  const f = fixture();
  const ui = render(
    <MouseProvider enabled>
      <Conversation
        client={f.client}
        feature={feature}
        stages={stages}
        profiles={profiles}
        onClose={() => {}}
        onArtifacts={() => {}}
        initialView={{ following: true, offset: 0, tools: false, messageText: "Keep this draft" }}
      />
    </MouseProvider>,
  );
  try {
    await ready(ui, "Waiting for agent output");
    f.stream().onEvent?.({
      type: "tool",
      name: "shellToolCall",
      phase: "start",
      raw: {
        call_id: "command-1",
        tool_call: { shellToolCall: { args: { command: "pnpm test" } } },
      },
    });
    await ready(ui, "Tool calling…");
    assert.doesNotMatch(ui.lastFrame()!, /shellToolCall|Run pnpm test/);
    ui.stdin.write("t");
    await pause();
    assert.match(ui.lastFrame()!, /Tool calling…/);
    assert.doesNotMatch(ui.lastFrame()!, /t tools|choose a call/);
    async function clickText(text: string) {
      const lines = ui.lastFrame()!.split("\n");
      const y = lines.findIndex((line) => line.includes(text));
      assert.ok(y >= 0, `Missing ${text}`);
      const x = lines[y]!.indexOf(text);
      ui.stdin.write(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`);
      await pause();
    }
    await clickText("Tool calling…");
    await ready(ui, "Run pnpm test");
    await new Promise((resolve) => setTimeout(resolve, 450));
    await clickText("Run pnpm test");
    await ready(ui, "Command: pnpm test");
    f.stream().onEvent?.({
      type: "tool",
      name: "shellToolCall",
      phase: "end",
      raw: {
        call_id: "command-1",
        tool_call: {
          shellToolCall: {
            args: { command: "pnpm test" },
            result: { success: { exitCode: 1, stdout: "2 tests passed", stderr: "Payment test failed" } },
          },
        },
      },
    });
    await ready(ui, "Payment test failed");
    assert.match(ui.lastFrame()!, /Failed/);
    ui.stdin.write("\x1b");
    await ready(ui, "Keep this draft");
    assert.match(ui.lastFrame()!, /1 call · 1 failed/);
    assert.doesNotMatch(ui.lastFrame()!, /Tool calling/);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});
