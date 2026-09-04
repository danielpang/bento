import { useEffect, useState } from "react";
import { Modal } from "./Modal.js";
import { useToast } from "./Toasts.js";
import { SettingsCardSkeleton } from "./Skeleton.js";
import {
  displayHighlights,
  filterHoursEntries,
  formatHours,
  formatHoursPhrase,
  formatHoursShare,
  HOURS_MATCH_CAP,
  hoursBarFill,
  hoursEntriesFromFeatures,
  hoursMeterState,
  hoursRestCopy,
  hoursUsage,
  monthlyTotalParts,
  money,
  overageCheckoutNote,
  rankHoursEntries,
  resetsOn,
  seatRate,
  startedOn,
  useBillingPlan,
  type HoursEntry,
  type PlanOffer,
  type PlanState,
} from "./billing-plan.js";

/**
 * The team's plan, on hosted deployments.
 *
 * Everything here talks to /api/billing, which only exists when the
 * deployment loads the cloud module; on an open source install the
 * first fetch 404s and the card renders nothing. That absence is the
 * boundary: the console carries the surface, the closed module carries
 * every decision about money.
 */
export function BillingCard() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { plan: state, absent } = useBillingPlan(busy);
  const [notice, setNotice] = useState("");
  const [salesOpen, setSalesOpen] = useState(false);
  const [plansOpen, setPlansOpen] = useState(false);
  const [allActivity, setAllActivity] = useState(false);

  if (absent) return null;
  if (!state) {
    return (
      <>
        <SettingsCardSkeleton rows={3} />
        <SettingsCardSkeleton rows={5} />
      </>
    );
  }

  const current = state.catalog.find((offer) => offer.plan === state.plan);

  async function post(path: string, body?: unknown): Promise<{ url?: string; error?: string }> {
    const res = await fetch(path, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!res.ok) throw new Error(parsed.error ?? `request failed with status ${res.status}`);
    return parsed;
  }

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setNotice("");
    try {
      await fn();
    } catch (err) {
      toast.fail(err);
    } finally {
      setBusy(false);
    }
  }

  /**
   * "1 of 3 members" where a cap exists, and where none does, the fact
   * that matters instead: on a paid plan every member is a billed
   * seat, which "(no limit)" said nothing about while also failing to
   * pluralise.
   */
  const members = (used: number, limit: number | null) => {
    const word = used === 1 ? "member" : "members";
    if (limit !== null) return `${used} of ${limit} ${word}.`;
    return `${used} ${word}, each a billed seat.`;
  };

  return (
    <>
      <section className="section settings-card">
        {/*
          The plan is the headline, not a word inside a sentence. The
          old line buried "Pro" mid-paragraph. The name is large; the
          team's monthly total and the per-user rate sit under it as
          two labeled figures, the same shape as Used and Left on the
          hours card, so neither has to be parsed out of a clause.
        */}
        <div className="plan-head">
          <h3 className="settings-title">Plan</h3>
          <span className="plan-name">{state.planName}</span>
          {current && <PlanPriceFacts offer={current} held={state.seats.held} />}
        </div>
        <p className="muted">{members(state.usage.members, state.limits.members)}</p>

        {notice && <p className="muted">{notice}</p>}
        {!state.canManageBilling && (
          <p className="muted">Only an owner or admin can change the plan for this team.</p>
        )}
        <div className="actions">
          {/*
            One button to the comparison rather than one per plan. The
            old pair named a limit and no price, so the first time anyone
            saw what they were agreeing to was on Stripe's own page,
            after the redirect.
          */}
          {state.canManageBilling && state.upgradable && state.plan !== "enterprise" && (
            <button className="btn btn-primary" disabled={busy} onClick={() => setPlansOpen(true)}>
              {state.plan === "free" ? "See plans and prices" : "Change plan"}
            </button>
          )}
          {state.canManageBilling && state.manageable && (
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const { url } = await post("/api/billing/portal");
                  if (url) window.location.assign(url);
                })
              }
            >
              Manage billing
            </button>
          )}
          {state.salesConfigured && (
            <button className="btn" disabled={busy} onClick={() => setSalesOpen(true)}>
              Enterprise: contact sales
            </button>
          )}
        </div>

        {/* Every upgrade, downgrade, cancellation and payment, so "did
            this go through" and "when did we change plan" have an answer
            in the product rather than only in the Stripe dashboard. */}
        {/*
          The recent few, expandable to the twenty the server sends,
          newest first. Not paginated further on purpose: this card is a
          glance at what happened lately, and the complete ledger with
          every invoice already exists in Stripe's portal one button up,
          under Manage billing. Building an archive here would duplicate
          one that is better somewhere else.
        */}
        {state.activity && state.activity.length > 0 && (
          <div className="field">
            <span className="label">Subscription activity</span>
            {(allActivity ? state.activity : state.activity.slice(0, 5)).map((entry, i) => (
              <div key={i} className="history-row">
                <span className="history-when">{new Date(entry.occurredAt).toLocaleDateString()}</span>
                <span className="history-what">
                  {describeActivity(entry.activity, entry.fromPlan, entry.toPlan)}
                  {entry.amountTotal !== null && (
                    <span className="muted"> {formatMoney(entry.amountTotal, entry.currency)}</span>
                  )}
                </span>
              </div>
            ))}
            {state.activity.length > 5 && (
              <button className="btn btn-ghost" onClick={() => setAllActivity((v) => !v)}>
                {allActivity ? "Show recent only" : `Show all ${state.activity.length}`}
              </button>
            )}
            {allActivity && state.activity.length >= 20 && (
              <span className="muted">
                Only the latest 20 changes are shown here. The complete history, every invoice
                included, is under Manage billing.
              </span>
            )}
          </div>
        )}
      </section>

      <AgentHoursCard
        state={state}
        busy={busy}
        canManage={state.canManageBilling}
        notice={notice}
        onOveragePolicy={(policy) =>
          act(async () => {
            await post("/api/billing/overage-policy", { policy });
            setNotice(
              OVERAGE_CHOICES.find((choice) => choice.policy === policy)?.confirmation(
                state.overage.usdPerAgentHour,
              ) ?? "Saved.",
            );
          })
        }
        onOverageCeiling={(ceilingUsd) =>
          act(async () => {
            await post("/api/billing/overage-ceiling", { ceilingUsd });
            setNotice(
              ceilingUsd === null
                ? "Removed the ceiling. Overage is billed with nothing stopping it."
                : `Agents stop once overage passes ${money(ceilingUsd)} in a period.`,
            );
          })
        }
      />

      {plansOpen && (
        <ChoosePlan
          offers={state.catalog}
          currentPlan={state.plan}
          heldSeats={state.seats.held}
          busy={busy}
          onClose={() => setPlansOpen(false)}
          onContactSales={() => {
            setPlansOpen(false);
            setSalesOpen(true);
          }}
          onChoose={(plan, overagePolicy) =>
            act(async () => {
              const result = await post("/api/billing/checkout", { plan, overagePolicy });
              // An existing subscription switches in place and answers
              // with no address, so there is nothing to redirect to and
              // the card simply reloads on the new plan.
              if (result.url) window.location.assign(result.url);
              else {
                setPlansOpen(false);
                setNotice("Plan changed. The next invoice is prorated from today.");
              }
            })
          }
        />
      )}

      {salesOpen && (
        <ContactSales
          onClose={() => setSalesOpen(false)}
          onSent={() => {
            setSalesOpen(false);
            setNotice("Sent. We reply to the address you gave, usually within a business day.");
          }}
        />
      )}
    </>
  );
}

/**
 * The two prices, labeled, so the team total is not a clause hanging
 * off the plan name and the per-user rate is not small print under it.
 */
function PlanPriceFacts({ offer, held }: { offer: PlanOffer; held: number }) {
  const paid = offer.pricing.perSeatUsd !== null && offer.pricing.perSeatUsd > 0;
  const total = monthlyTotalParts(offer, held);
  const rate = seatRate(offer.pricing);
  if (!paid || !total || !rate) return null;
  return (
    <div className="plan-facts">
      <div className="plan-fact">
        <span className="label">This team</span>
        <span className="plan-fact-value">{total.amount}</span>
        {total.seats && <span className="muted">{total.seats}</span>}
      </div>
      <div className="plan-fact">
        <span className="label">Per user</span>
        <span className="plan-fact-value">{rate}</span>
      </div>
    </div>
  );
}

/**
 * Which cards spent the hours this billing month, without listing the board.
 *
 * Hours are summed per feature from the plan's period start (the
 * organization's billing anniversary), heaviest first. The heaviest
 * few are the signal. The rest collapse to a count and a title field,
 * because a "show all" of forty cards is a directory that pushes the
 * overage choice off the screen and still does not help anyone find a
 * card.
 */
function HoursByCard({ state, used }: { state: PlanState; used: number }) {
  const billed = state.usageByFeature;
  const [entries, setEntries] = useState<HoursEntry[] | null>(
    billed !== undefined ? hoursEntriesFromFeatures(billed) : null,
  );

  useEffect(() => {
    if (billed !== undefined) {
      setEntries(hoursEntriesFromFeatures(billed));
      return;
    }
    const from = encodeURIComponent(state.agentHours.periodStart);
    const to = encodeURIComponent(state.agentHours.periodEnd);
    let cancelled = false;
    void fetch(`/api/team/hours?from=${from}&to=${to}`, { credentials: "include" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setEntries([]);
          return;
        }
        const body = (await res.json()) as {
          features?: { featureId: string; title: string; agentHours: number }[];
        };
        setEntries(hoursEntriesFromFeatures(body.features ?? []));
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [billed, state.agentHours.periodStart, state.agentHours.periodEnd]);

  if (!entries) return null;
  return <HoursBreakdown entries={entries} used={used} periodStart={state.agentHours.periodStart} />;
}

const CARD_NOUN = { singular: "card", plural: "cards" };

function HoursBreakdown({
  entries,
  used,
  periodStart,
}: {
  entries: HoursEntry[];
  used: number;
  periodStart: string;
}) {
  const [query, setQuery] = useState("");
  const { ranked, preview, rest, restHours } = rankHoursEntries(entries);
  if (ranked.length === 0) return null;

  const heaviest = ranked[0]?.agentHours ?? 0;
  const searching = query.trim().length > 0;
  const matches = searching ? filterHoursEntries(ranked, query) : preview;
  const shown = searching ? matches.slice(0, HOURS_MATCH_CAP) : matches;
  const truncated = searching && matches.length > shown.length;
  const scroll = shown.length > 5;
  const since = startedOn(periodStart);

  return (
    <div className="field">
      <div className="hours-people-head">
        <span className="label">By card</span>
        <span className="muted">
          {searching
            ? `${matches.length} of ${ranked.length} ${ranked.length === 1 ? "card" : "cards"}`
            : `${ranked.length} ${ranked.length === 1 ? "card" : "cards"} since ${since}`}
        </span>
      </div>
      {rest.length > 0 && (
        <input
          className="input hours-people-find"
          type="search"
          value={query}
          placeholder="Find a card"
          aria-label="Find which card used agent hours"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && searching) {
              e.preventDefault();
              setQuery("");
            }
          }}
        />
      )}
      {shown.length > 0 ? (
        <div className="hours-people" data-scroll={scroll || undefined}>
          {shown.map((entry) => (
            <HoursEntryRow key={entry.id} entry={entry} heaviest={heaviest} used={used} />
          ))}
        </div>
      ) : (
        <p className="muted">No card matching that title used hours this period.</p>
      )}
      {truncated && <p className="muted">Showing the first {HOURS_MATCH_CAP}. Type more of the title.</p>}
      {!searching && rest.length > 0 && (
        <p className="hours-people-rest">{hoursRestCopy(rest.length, restHours, used, CARD_NOUN)}</p>
      )}
    </div>
  );
}

function HoursEntryRow({
  entry,
  heaviest,
  used,
}: {
  entry: HoursEntry;
  heaviest: number;
  used: number;
}) {
  const fill = hoursBarFill(entry.agentHours, heaviest);
  const share = formatHoursShare(entry.agentHours, used);
  return (
    <div className="hours-person">
      <a className="hours-person-name" href={`/?feature=${entry.id}`} title="Open this card">
        {entry.name}
      </a>
      <div className="hours-person-track" aria-hidden="true">
        <div className="hours-person-fill" style={{ width: `${Math.round(fill * 1000) / 10}%` }} />
      </div>
      <span className="hours-person-figure">
        <span>{formatHoursPhrase(entry.agentHours)}</span>
        {share && <span className="muted">{share}</span>}
      </span>
    </div>
  );
}

/**
 * The team's hours this period, as their own card.
 *
 * Seats and hours were one paragraph, so the figure everyone opens
 * Billing to check (how much is left, which cards spent it) sat in a
 * sentence with the headcount. The meter, the leftover, and the
 * per-card rows are the same facts, readable without parsing prose.
 */
function AgentHoursCard({
  state,
  busy,
  canManage,
  notice,
  onOveragePolicy,
  onOverageCeiling,
}: {
  state: PlanState;
  busy: boolean;
  canManage: boolean;
  notice: string;
  onOveragePolicy: (policy: "stop" | "allow") => void;
  onOverageCeiling: (ceilingUsd: number | null) => void;
}) {
  const usage = hoursUsage(state.agentHours);
  const meter = hoursMeterState(usage, state.stopped);
  const leftoverLabel = usage.overage > 0 ? "Overage" : "Left";
  const stoppedNote =
    state.stopped === "ceiling"
      ? "New agents are not starting. Overage has reached the ceiling this team set."
      : state.stopped === "pool"
        ? "New agents are not starting. The included hours are used."
        : null;

  return (
    <section className="section settings-card">
      <h3 className="settings-title">Agent hours</h3>
      <p className="muted">Hours are pooled for the whole team.</p>

      <div className="hours-usage">
        <div className="hours-usage-head">
          <span className="hours-usage-count">
            {formatHours(usage.used)} of {formatHours(usage.included)} used
          </span>
          <span className="muted">
            {usage.overage > 0
              ? `${formatHoursPhrase(usage.overage)} over the included pool`
              : usage.remaining === 0
                ? "None left this period"
                : `${formatHoursPhrase(usage.remaining)} left`}
          </span>
        </div>
        <div
          className="hours-meter"
          role="meter"
          aria-label="Agent hours used"
          aria-valuemin={0}
          aria-valuemax={usage.included}
          aria-valuenow={Math.min(usage.used, usage.included)}
          aria-valuetext={`${formatHours(usage.used)} of ${formatHours(usage.included)} hours used`}
        >
          <div
            className="hours-meter-fill"
            data-state={meter}
            style={{ width: `${Math.round(usage.fillRatio * 1000) / 10}%` }}
          />
        </div>
        <div className="hours-facts">
          <div className="hours-fact">
            <span className="label">Used</span>
            <span className="hours-fact-value">{formatHoursPhrase(usage.used)}</span>
          </div>
          <div className="hours-fact">
            <span className="label">{leftoverLabel}</span>
            <span className="hours-fact-value">
              {formatHoursPhrase(usage.overage > 0 ? usage.overage : usage.remaining)}
            </span>
          </div>
          <div className="hours-fact">
            <span className="label">Resets</span>
            <span className="hours-fact-value">{resetsOn(state)}</span>
          </div>
        </div>
      </div>

      {stoppedNote && <p className="warn">{stoppedNote}</p>}

      <HoursByCard state={state} used={usage.used} />

      {/*
        What happens at the end of the allowance, as a choice rather
        than as our policy. A team on a deadline would rather find $40
        on the invoice than a board that stopped overnight, and a team
        on a budget would much rather the reverse. Neither is wrong
        about their own situation, so neither should be assumed.
      */}
      {state.overage.changeable && (
        <div className="field">
          <span className="label">When the included hours run out</span>
          {OVERAGE_CHOICES.map((choice) => (
            <label key={choice.policy} className="overage-choice">
              <input
                type="radio"
                name="overage-policy"
                checked={state.overage.policy === choice.policy}
                disabled={busy || !canManage}
                onChange={() => onOveragePolicy(choice.policy)}
              />
              <span>
                <strong>{choice.label}</strong>
                <span className="muted"> {choice.help(state.overage.usdPerAgentHour)}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      {/*
        A ceiling, which binds even for a team that chose to pay. They
        agreed to pay for what they use; they did not agree to pay for
        whatever a loop can spend overnight.
      */}
      {state.overage.changeable && state.overage.policy === "allow" && (
        <label className="field">
          <span className="label">Stop anyway past</span>
          <div className="actions">
            <input
              className="input"
              type="number"
              min={0}
              step={10}
              placeholder="no ceiling"
              defaultValue={state.overage.ceilingUsd ?? ""}
              disabled={busy || !canManage}
              aria-label="Overage ceiling in dollars"
              onBlur={(e) => {
                const raw = e.target.value.trim();
                const next = raw === "" ? null : Number(raw);
                if (next !== null && !Number.isFinite(next)) return;
                if (next === state.overage.ceilingUsd) return;
                onOverageCeiling(next);
              }}
            />
            <span className="muted">{money(state.overage.spentUsd)} of overage so far this period.</span>
          </div>
        </label>
      )}
      {notice && <p className="muted">{notice}</p>}
      {!canManage && state.overage.changeable && (
        <p className="muted">Only an owner or admin can change this.</p>
      )}
    </section>
  );
}

/**
 * The ladder, priced for this team, as a full height panel.
 *
 * A panel and not a modal, because comparing four plans is a reading
 * task: the cards sit side by side in one row, so a difference is a
 * glance across rather than a scroll and a memory. The layout borrows
 * the card drawer's idiom, slid in from the right over a backdrop,
 * just wider.
 *
 * Every plan shows what this team in particular would pay, since per
 * seat pricing makes the headline price the least useful number here.
 */
function ChoosePlan({
  offers,
  currentPlan,
  heldSeats,
  busy,
  onClose,
  onChoose,
  onContactSales,
}: {
  offers: PlanOffer[];
  currentPlan: string;
  heldSeats: number;
  busy: boolean;
  onClose: () => void;
  onChoose: (plan: string, overagePolicy: "stop" | "allow") => void;
  onContactSales: () => void;
}) {
  /**
   * Two steps on purpose. The plan is the decision they came for; what
   * happens past the allowance is a second one, and stacking it into
   * the same click is how it would get answered by not reading it. The
   * question lands as a footer under the row, so the cards stay put
   * for comparing against the choice.
   */
  const [picked, setPicked] = useState<PlanOffer | null>(null);
  const [policy, setPolicy] = useState<"stop" | "allow" | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="plans-backdrop" onClick={onClose} />
      <aside className="plans-panel" role="dialog" aria-label="Plans">
        <header className="drawer-head">
          <div className="drawer-title-row">
            <h2 className="drawer-title">Plans</h2>
            <button className="btn btn-ghost" disabled={busy} onClick={onClose}>
              Close
            </button>
          </div>
          <p className="muted" style={{ margin: 0 }}>
            Priced for this team as it stands, {heldSeats} {heldSeats === 1 ? "person" : "people"}{" "}
            counting open invitations.
          </p>
        </header>
        <div className="plans-panel-body">
          <div className="plan-row">
            {offers.map((offer) => {
              const isCurrent = offer.plan === currentPlan;
              const paid = offer.pricing.perSeatUsd !== null && offer.pricing.perSeatUsd > 0;
              return (
                <div
                  key={offer.plan}
                  className={`plan-option${isCurrent ? " plan-option-current" : ""}${picked?.plan === offer.plan ? " plan-option-picked" : ""}`}
                >
                  <div className="plan-option-head">
                    <strong>{offer.name}</strong>
                  </div>
                  {paid ? (
                    <PlanPriceFacts offer={offer} held={heldSeats} />
                  ) : (
                    <span className="plan-option-price">$0</span>
                  )}
                  <p className="muted">{offer.pricing.summary}</p>
                  <ul className="plan-option-list">
                    {displayHighlights(offer.pricing.highlights).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                    <li>
                      {offer.pricing.overageUsdPerAgentHour === null
                        ? "Runs pause once the included hours are used"
                        : `Then ${money(offer.pricing.overageUsdPerAgentHour)} an agent hour`}
                    </li>
                  </ul>
                  {isCurrent ? (
                    <span className="muted">This team's plan</span>
                  ) : offer.pricing.perSeatUsd === null || offer.plan === "enterprise" ? (
                    <button className="btn" disabled={busy} onClick={onContactSales}>
                      Contact sales
                    </button>
                  ) : offer.plan === "free" ? (
                    // Downgrading to Free is a cancellation, and
                    // cancelling belongs in the portal where the last
                    // invoice and the end date are visible.
                    <span className="muted">Cancel under Manage billing</span>
                  ) : (
                    <button className="btn btn-primary" disabled={busy} onClick={() => setPicked(offer)}>
                      Choose {offer.name}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {/*
          The question is asked here rather than defaulted, because a
          default is wrong for somebody either way: stopping surprises
          a team on a deadline, paying surprises a team on a budget.
        */}
        {picked && (
          <footer className="plans-panel-foot">
            <span className="label">
              One more thing, for {picked.name}: what happens when the{" "}
              {picked.pricing.includedAgentHours} hours run out?
            </span>
            {OVERAGE_CHOICES.map((choice) => (
              <label key={choice.policy} className="overage-choice">
                <input
                  type="radio"
                  name="checkout-overage"
                  checked={policy === choice.policy}
                  disabled={busy}
                  onChange={() => setPolicy(choice.policy)}
                />
                <span>
                  <strong>{choice.label}</strong>
                  <span className="muted"> {choice.help(picked.pricing.overageUsdPerAgentHour)}</span>
                </span>
              </label>
            ))}
            <div className="actions">
              <button
                className="btn btn-primary"
                disabled={busy || policy === null}
                onClick={() => policy && onChoose(picked.plan, policy)}
              >
                {policy === null ? "Pick one to continue" : "Continue to payment"}
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setPicked(null)}>
                Back to plans
              </button>
            </div>
            {/*
              Said before they pick, not discovered when it bites. A
              ceiling nobody was told about is worse than no ceiling.
            */}
            <span className="muted">{overageCheckoutNote(policy, picked.monthlyTotalUsd)}</span>
          </footer>
        )}
      </aside>
    </>
  );
}

/**
 * The two answers, worded so that picking one does not need the other
 * explained. Each says what happens to the work and what happens to
 * the money, because those are the two things being traded.
 */
const OVERAGE_CHOICES: {
  policy: "stop" | "allow";
  label: string;
  help: (rate: number | null) => string;
  confirmation: (rate: number | null) => string;
}[] = [
  {
    policy: "stop",
    label: "Stop starting agents",
    help: () =>
      "Cards stay where they are until next month, or until somebody changes this. Nothing already running is interrupted, and no work is lost.",
    confirmation: () => "Agents will stop when the included hours are used.",
  },
  {
    policy: "allow",
    label: "Keep going and bill the difference",
    help: (rate) =>
      rate === null
        ? "Work continues past the included hours."
        : `Work continues at ${money(rate)} an agent hour, added to the next invoice.`,
    confirmation: (rate) =>
      rate === null
        ? "Agents will keep running past the included hours."
        : `Agents will keep running, at ${money(rate)} an agent hour.`,
  },
];

const PLAN_WORDS: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  business: "Business",
  enterprise: "Enterprise",
};

/**
 * The activity in words. Mirrors the cloud module's own wording; the
 * console cannot import from it, since that package is not part of the
 * open source build.
 */
function describeActivity(activity: string, fromPlan: string | null, toPlan: string | null): string {
  const from = fromPlan ? (PLAN_WORDS[fromPlan] ?? fromPlan) : null;
  const to = toPlan ? (PLAN_WORDS[toPlan] ?? toPlan) : null;
  switch (activity) {
    case "started":
      return `Started the ${to} plan`;
    case "upgraded":
      return `Upgraded from ${from} to ${to}`;
    case "downgraded":
      return `Downgraded from ${from} to ${to}`;
    case "cancelled":
      return from ? `Cancelled the ${from} plan` : "Cancelled the subscription";
    case "renewed":
      return "Renewal paid";
    case "payment":
      return "Payment received";
    case "payment_failed":
      return "Payment failed";
    default:
      return activity;
  }
}

/** Stripe reports minor units, so cents become the currency's own shape. */
function formatMoney(amount: number | null, currency: string | null): string {
  if (amount === null) return "Payment";
  const code = (currency ?? "usd").toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: code }).format(amount / 100);
  } catch {
    // An unknown currency code must not blank the whole row.
    return `${(amount / 100).toFixed(2)} ${code}`;
  }
}

function ContactSales({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const toast = useToast();
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!message.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/billing/contact-sales", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: message.trim(),
          ...(email.trim() ? { email: email.trim() } : {}),
          ...(company.trim() ? { company: company.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "the message could not be sent");
      }
      onSent();
    } catch (err) {
      toast.fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Talk to us about Enterprise"
      description="SSO, SCIM, sandboxes in your own Fly organization, and 2000 hours a period. Tell us about your team and we reply by email."
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !message.trim()} onClick={() => void submit()}>
            {busy ? "Sending..." : "Send"}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="label">Your email</span>
        <input
          className="input"
          type="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
        />
      </label>
      <label className="field">
        <span className="label">Company (optional)</span>
        <input className="input" value={company} onChange={(e) => setCompany(e.target.value)} />
      </label>
      <label className="field">
        <span className="label">What do you need?</span>
        <textarea
          className="input skill-input"
          rows={5}
          placeholder="Team size, where you need code to run, anything the standard plans do not cover."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </label>
    </Modal>
  );
}
