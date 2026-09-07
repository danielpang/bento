import { ApiError, type BentoClient, type PlanState, type OrganizationDetails } from "@bento/api-client";
import type { SettingsUI } from "./workbench-settings.js";

export const hasRole = (role: string, value: string) => role.split(",").some((part) => part.trim() === value);
const money = (value: number | null) => (value === null ? "Custom pricing" : `$${value.toFixed(2)} USD`);
export function seatChangeNote(state: PlanState | null, delta: 1 | -1): string {
  const offer = state?.catalog.find((entry) => entry.plan === state.plan);
  const rate = offer?.pricing.perSeatUsd;
  if (!state?.seats.billed || !offer || !rate) return "";
  const before = Math.max(state.seats.held, offer.pricing.minimumSeats);
  const after = Math.max(state.seats.held + delta, offer.pricing.minimumSeats);
  return before === after
    ? `The bill stays at ${money(before * rate)} per month because of the ${before} seat minimum.`
    : `The bill changes from ${money(before * rate)} to ${money(after * rate)} per month, prorated from today.`;
}

/** The same organization and billing APIs used by the console, with explicit financial decisions. */
export function accountSettings(
  client: BentoClient,
  ui: SettingsUI,
  reset: (signedOut?: boolean) => Promise<void>,
) {
  const { list, choice, read, form, act, confirm, load } = ui;
  async function planOrAbsent() {
    try {
      return await client.getBillingPlan();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }
  async function active() {
    const session = await client.getAccountSession();
    if (!session) throw new Error("Your session has expired. Sign in again.");
    let org: OrganizationDetails | null = null;
    if (session.session.activeOrganizationId) {
      try {
        org = await client.getOrganization(session.session.activeOrganizationId);
      } catch (error) {
        // A removed membership can leave the session pointing at an inaccessible team.
        // Keep organization switching and sign out reachable, but never hide an outage.
        if (!(error instanceof ApiError) || ![403, 404].includes(error.status)) throw error;
      }
    }
    const me = org?.members.find((member) => member.userId === session.user.id);
    return {
      session,
      org,
      owner: hasRole(me?.role ?? "", "owner"),
      manage: ["owner", "admin"].some((r) => hasRole(me?.role ?? "", r)),
    };
  }
  function switchTo(id: string) {
    void load(async () => {
      await client.setActiveOrganization(id);
      await reset();
    });
  }
  function organizations() {
    void load(async () => {
      const orgs = await client.listOrganizations();
      list("Switch organization", [
        ...orgs.map((org) => choice(org.id, org.name, () => switchTo(org.id), org.slug)),
        choice("create", "Create organization", () =>
          form("Organization name", (name) => {
            if (!name.trim()) return;
            form(
              "Organization slug",
              (slug) => {
                void load(async () => {
                  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
                    throw new Error("Use lowercase letters, numbers and single hyphens.");
                  const org = await client.createOrganization(name.trim(), slug);
                  // Keep the created organization reachable if switching fails.
                  list("Organization created", [choice(org.id, `Open ${org.name}`, () => switchTo(org.id))]);
                });
              },
              {
                value: name
                  .toLowerCase()
                  .trim()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-|-$/g, "")
                  .slice(0, 40)
                  .replace(/-$/, ""),
              },
            );
          }),
        ),
        choice("invitations", "Your invitations", invitations),
      ]);
    });
  }
  function invitations() {
    void load(async () => {
      const invites = (await client.listInvitations()).filter(
        (i) => i.status === "pending" && Date.parse(i.expiresAt) > Date.now(),
      );
      list(
        "Your invitations",
        invites.map((invite) =>
          choice(
            invite.id,
            invite.organizationName ?? invite.organizationId,
            () =>
              list("Invitation", [
                choice("accept", "Accept invitation", () =>
                  confirm("Accept invitation", `Join as ${invite.role}.`, async () => {
                    await client.respondToInvitation(invite.id, true);
                  }),
                ),
                choice("reject", "Decline invitation", () =>
                  confirm("Decline invitation", "This invitation will no longer be usable.", () =>
                    client.respondToInvitation(invite.id, false),
                  ),
                ),
              ]),
            `${invite.role} · Expires ${new Date(invite.expiresAt).toLocaleDateString()}`,
          ),
        ),
      );
    });
  }
  function team() {
    void load(async () => {
      const { session, org, owner, manage } = await active();
      if (!org) {
        list("Choose an organization", [choice("organizations", "Your organizations", organizations)]);
        return;
      }
      const owners = org.members.filter((m) => hasRole(m.role, "owner")).length;
      list(`${org.name} · Team`, [
        choice("organizations", "Switch or create organization", organizations),
        choice("invitations", "Your invitations", invitations),
        choice("policy", "Agent network access", () => {
          void load(async () => {
            const policy = await client.getTeamPolicy();
            list("Agent network access", [
              choice("status", policy.restrictNetwork ? "Restricted network" : "Unrestricted network", () =>
                read("Network policy", [
                  "Restricted agents run with no route to the internet. This can prevent package installs and documentation access.",
                  policy.supported
                    ? "This deployment supports network restrictions."
                    : "This deployment does not support network restrictions.",
                  "Changes apply to newly provisioned sandboxes.",
                ]),
              ),
              ...(policy.canEdit && (policy.supported || policy.restrictNetwork)
                ? [
                    choice(
                      "toggle",
                      policy.restrictNetwork ? "Allow outbound traffic" : "Restrict outbound traffic",
                      () =>
                        confirm("Change network policy", "This affects agents in this organization.", () =>
                          client.setTeamPolicy(!policy.restrictNetwork),
                        ),
                    ),
                  ]
                : []),
            ]);
          });
        }),
        ...(manage
          ? [
              choice("invite", "Invite a member", () =>
                form("Invite email address", (email) => {
                  if (!email.trim()) return;
                  list(
                    "Invitation role",
                    (owner ? ["member", "admin", "owner"] : ["member", "admin"]).map((role) =>
                      choice(role, role, () => {
                        void load(async () => {
                          const plan = await planOrAbsent();
                          confirm(
                            "Send invitation",
                            `Invite ${email.trim()} as ${role}. Invitations reserve a seat immediately. ${role === "owner" ? "Owners have full control, including deleting this organization. " : ""}${seatChangeNote(plan, 1)}`,
                            () => client.inviteMember(org.id, email.trim(), role),
                          );
                        });
                      }),
                    ),
                  );
                }),
              ),
            ]
          : []),
        ...org.members.map((member) =>
          choice(
            member.id,
            `${member.user.name} (${member.user.email})`,
            () => {
              const isOwner = hasRole(member.role, "owner");
              const canChange = manage && (!isOwner || owner) && !(isOwner && owners <= 1);
              list(member.user.name, [
                choice("details", "Member details", () =>
                  read("Member", [
                    member.user.name,
                    member.user.email,
                    member.role,
                    ...(isOwner && owners <= 1
                      ? ["Promote another owner before removing or demoting the last owner."]
                      : []),
                  ]),
                ),
                ...(canChange
                  ? [
                      choice("role", "Change role", () =>
                        list(
                          "New role",
                          (owner ? ["member", "admin", "owner"] : ["member", "admin"]).map((role) =>
                            choice(role, role, () =>
                              confirm(
                                "Change role",
                                `${member.user.email} will become ${role}. ${role === "owner" ? "Owners can delete the organization and control billing." : "Their permissions change immediately."}`,
                                async () => {
                                  await client.updateMemberRole(org.id, member.id, role);
                                  if (member.userId === session.user.id) await reset();
                                },
                              ),
                            ),
                          ),
                        ),
                      ),
                      choice("remove", "Remove member", () => {
                        void load(async () => {
                          const plan = await planOrAbsent();
                          confirm(
                            "Remove member",
                            `${member.user.email} loses access immediately. ${seatChangeNote(plan, -1)}`,
                            async () => {
                              await client.removeMember(org.id, member.id);
                              if (member.userId === session.user.id) await reset();
                            },
                          );
                        });
                      }),
                    ]
                  : []),
              ]);
            },
            member.role,
          ),
        ),
        ...org.invitations
          .filter((i) => i.status === "pending")
          .map((invite) =>
            choice(
              invite.id,
              `Pending: ${invite.email}`,
              () => {
                if (!manage) {
                  read("Invitation", [invite.email, invite.role, `Expires ${invite.expiresAt}`]);
                  return;
                }
                void load(async () => {
                  const plan = await planOrAbsent();
                  confirm(
                    "Cancel invitation",
                    `${invite.email} will no longer be able to accept. ${seatChangeNote(plan, -1)}`,
                    () => client.cancelInvitation(invite.id),
                  );
                });
              },
              invite.role,
            ),
          ),
      ]);
    });
  }
  function deleteOrg(org: OrganizationDetails) {
    form(
      `Delete ${org.name}`,
      (name) => {
        void load(async () => {
          if (name !== org.name) throw new Error("The organization name does not match.");
          await client.deleteOrganization(org.id);
          await reset();
        });
      },
      {
        hint: `Permanently deletes projects, cards, runs and credentials, removes member access and cancels the subscription. Type ${org.name} to delete.`,
      },
    );
  }
  function account() {
    void load(async () => {
      const { session, org, owner } = await active();
      list(session.user.email, [
        choice("profile", "Account details", () =>
          read("Account", [
            session.user.name,
            session.user.email,
            session.user.emailVerified ? "Email verified" : "Email not verified",
            `Organization: ${org?.name ?? "none"}`,
          ]),
        ),
        choice("name", "Change display name", () =>
          form(
            "Display name",
            (name) =>
              act("Name saved", async () => {
                if (!name.trim()) throw new Error("Enter a name.");
                await client.updateAccountName(name.trim());
              }),
            { value: session.user.name },
          ),
        ),
        choice("organizations", "Your organizations", organizations),
        choice("signout", "Sign out of this client", () =>
          confirm("Sign out", "The saved session for this server will be removed.", async () => {
            await client.signOut();
            await reset(true);
          }),
        ),
        ...(owner && org ? [choice("delete-org", "Delete this organization", () => deleteOrg(org))] : []),
        choice("delete", "Delete your account", () => {
          void load(async () => {
            const orgs = await client.listOrganizations();
            const details = await Promise.all(orgs.map((o) => client.getOrganization(o.id)));
            const owned = details.filter((o) =>
              o.members.some((m) => m.userId === session.user.id && hasRole(m.role, "owner")),
            );
            if (owned.length) {
              read("Transfer ownership first", [
                "Transfer ownership and remove your owner role, or delete these organizations before deleting your account:",
                ...owned.map((o) => o.name),
              ]);
              return;
            }
            confirm(
              "Request account deletion",
              `Send a deletion confirmation to ${session.user.email}. Your account is deleted only after you confirm using that email.`,
              async () => {
                await client.requestAccountDeletion();
              },
            );
          });
        }),
      ]);
    });
  }
  function portal() {
    void load(async () => {
      const result = await client.createBillingPortal();
      if (!result.url) throw new Error("The billing provider did not return a portal link. Try again.");
      read("Payment details, invoices and cancellation", [
        "Open this secure billing provider link:",
        result.url,
        "Return here and reopen Billing to refresh the plan.",
      ]);
    });
  }
  function sales() {
    form("Reply email (optional)", (email) =>
      form("Company (optional)", (company) =>
        form(
          "Message to the sales team",
          (message) => {
            if (!message.trim()) return;
            confirm(
              "Contact sales",
              `Send this message to Bento sales. Reply address: ${email.trim() || "your account email"}.`,
              () =>
                client.contactSales(message.trim(), email.trim() || undefined, company.trim() || undefined),
            );
          },
          { multiline: true },
        ),
      ),
    );
  }
  function billing() {
    void load(async () => {
      const state = await planOrAbsent();
      if (!state) {
        read("Billing", ["This deployment does not provide hosted billing."]);
        return;
      }
      list(`${state.planName} · Billing`, [
        choice("usage", "Plan and usage", () =>
          read("Plan and usage", [
            `${state.planName} · ${state.status ?? "active"}`,
            `${state.seats.held} held seats · ${state.seats.billable} billable seats · ${money(state.seats.monthlyTotalUsd)} per month`,
            `${state.agentHours.used.toFixed(1)} of ${state.agentHours.included} included agent hours`,
            `Period: ${new Date(state.agentHours.periodStart).toLocaleDateString()} to ${new Date(state.agentHours.periodEnd).toLocaleDateString()}`,
            state.stopped
              ? `New runs stopped: ${state.stopped === "ceiling" ? "overage spending limit reached" : "included hours used"}`
              : "New runs are allowed by this plan.",
            `After included hours: ${state.overage.policy === "stop" ? "stop agents" : `continue at ${money(state.overage.usdPerAgentHour)} per agent hour`}`,
            `Overage spent: ${money(state.overage.spentUsd)} · Limit: ${state.overage.ceilingUsd === null ? "none" : money(state.overage.ceilingUsd)}`,
          ]),
        ),
        choice("cards", "Usage by card", () => {
          void load(async () => {
            const features =
              state.usageByFeature ??
              (await client.getTeamHours(state.agentHours.periodStart, state.agentHours.periodEnd)).features;
            read(
              "Usage by card",
              [...features]
                .sort((a, b) => b.agentHours - a.agentHours)
                .map((f) => `${f.agentHours.toFixed(1)} hours · ${f.title}`),
            );
          });
        }),
        choice("members", "Usage by member", () =>
          read(
            "Usage by member",
            [...state.usageByMember]
              .sort((a, b) => b.agentHours - a.agentHours)
              .map((m) => `${m.agentHours.toFixed(1)} hours · ${m.name ?? "Automated runs"}`),
          ),
        ),
        choice("activity", "Billing activity", () =>
          read(
            "Billing activity",
            (state.activity ?? []).map(
              (a) =>
                `${new Date(a.occurredAt).toLocaleString()} · ${a.activity} · ${a.fromPlan ?? ""} → ${a.toPlan ?? ""}${a.amountTotal === null ? "" : ` · ${(a.amountTotal / 100).toFixed(2)} ${(a.currency ?? "").toUpperCase()}`}`,
            ),
          ),
        ),
        choice("plans", "Compare plans", () =>
          list(
            "Plans",
            state.catalog.map((offer) =>
              choice(
                offer.plan,
                offer.name,
                () =>
                  list(offer.name, [
                    choice("details", "Plan details", () =>
                      read(offer.name, [
                        offer.pricing.summary,
                        `${money(offer.pricing.perSeatUsd)} per seat per month${offer.pricing.fromPrice ? " (starting price)" : ""}`,
                        `${offer.pricing.minimumSeats} minimum seats · ${offer.billableSeats} billable seats for this team`,
                        `${money(offer.monthlyTotalUsd)} per month for this team`,
                        `${offer.pricing.includedAgentHours} included agent hours`,
                        `${money(offer.pricing.overageUsdPerAgentHour)} per additional agent hour`,
                        `Member limit: ${offer.limits.members ?? "none"}`,
                      ]),
                    ),
                    ...(state.canManageBilling &&
                    state.upgradable &&
                    state.plan !== "enterprise" &&
                    ["pro", "business"].includes(offer.plan) &&
                    offer.plan !== state.plan &&
                    offer.monthlyTotalUsd !== null &&
                    offer.monthlyTotalUsd > 0
                      ? [
                          choice("choose", `Choose ${offer.name}`, () =>
                            list(
                              "After included hours are used",
                              (["stop", "allow"] as const).map((policy) =>
                                choice(
                                  policy,
                                  policy === "stop"
                                    ? "Stop agents at the included allowance"
                                    : "Keep going with paid overage",
                                  () =>
                                    confirm(
                                      `Switch to ${offer.name}`,
                                      `${offer.billableSeats} seats, ${money(offer.monthlyTotalUsd)} per month. Existing subscriptions are prorated today. ${policy === "stop" ? "Agents stop after included hours." : `Overage costs ${money(offer.pricing.overageUsdPerAgentHour)} per hour, initially capped at ${money(offer.monthlyTotalUsd)}. Change or remove the cap under Billing.`}`,
                                      async () => {
                                        const result = await client.checkoutPlan(offer.plan, policy);
                                        if (result.url)
                                          read("Complete checkout", [
                                            result.url,
                                            "Complete payment in your browser, then reopen Billing.",
                                          ]);
                                      },
                                    ),
                                ),
                              ),
                            ),
                          ),
                        ]
                      : []),
                    ...(offer.plan === "enterprise" && state.salesConfigured
                      ? [choice("sales", "Discuss Enterprise with sales", sales)]
                      : []),
                    ...(state.canManageBilling &&
                    state.manageable &&
                    offer.monthlyTotalUsd === 0 &&
                    offer.plan !== state.plan
                      ? [choice("cancel", "Cancel subscription in billing portal", portal)]
                      : []),
                  ]),
                `${money(offer.monthlyTotalUsd)} per month · ${offer.pricing.includedAgentHours} hours`,
              ),
            ),
          ),
        ),
        ...(state.canManageBilling && state.overage.changeable
          ? [
              choice("policy", "Change overage policy", () =>
                confirm(
                  "Change overage policy",
                  state.overage.policy === "allow"
                    ? "New agents stop when included hours are used."
                    : `Keep agents running at ${money(state.overage.usdPerAgentHour)} per additional hour. Spending limit: ${state.overage.ceilingUsd === null ? "none" : money(state.overage.ceilingUsd)}.`,
                  () => client.setOveragePolicy(state.overage.policy === "stop" ? "allow" : "stop"),
                ),
              ),
              choice("ceiling", "Set overage spending limit", () =>
                form(
                  "Monthly overage limit in USD",
                  (value) => {
                    void load(async () => {
                      const ceiling = Number(value);
                      if (!value.trim() || !Number.isFinite(ceiling) || ceiling < 0)
                        throw new Error("Enter a finite amount of zero or more.");
                      confirm(
                        "Set overage limit",
                        `New agents stop when overage spending reaches ${money(ceiling)}.`,
                        () => client.setOverageCeiling(ceiling),
                      );
                    });
                  },
                  { value: state.overage.ceilingUsd === null ? "" : String(state.overage.ceilingUsd) },
                ),
              ),
              ...(state.overage.ceilingUsd !== null
                ? [
                    choice("uncap", "Remove overage spending limit", () =>
                      confirm(
                        "Remove spending limit",
                        "Paid overage will have no spending limit when the policy allows agents to continue.",
                        () => client.setOverageCeiling(null),
                      ),
                    ),
                  ]
                : []),
            ]
          : []),
        ...(state.canManageBilling && state.manageable
          ? [choice("portal", "Payment details, invoices and cancellation", portal)]
          : []),
        ...(state.salesConfigured ? [choice("sales", "Contact sales", sales)] : []),
      ]);
    });
  }
  return { team, account, billing };
}
