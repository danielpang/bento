# Product Investigation: User Waitlist for usebento.ai

## Problem Statement

As usebento.ai grows in popularity, we may face scaling concerns. A user waitlist feature would allow us to onboard people in waves, preventing system overload and ensuring a smooth experience for all users.

## Current Architecture

### Multi-tenant SaaS (bento-cloud)
- **Authentication**: better-auth with email/password, Google, GitHub OAuth
- **Organizations**: Teams share a board; creator becomes owner
- **Billing**: Stripe-based with Free, Pro, Business, Enterprise plans
- **Compute limits**: Agent hours per billing period with overage policies

### Open Source Server (bento/apps/server)
- **Local mode**: Single user, no auth required
- **Multi mode**: Full auth, organizations, invitations
- **Agent runs**: Queued and executed in sandboxes

## Waitlist Feature Design

### 1. Waitlist Entry Points

#### Public Landing Page (usebento.ai)
- Simple email capture form
- "Join the waitlist" CTA
- Optional: Company name, role, team size, use case
- Immediate confirmation email

#### In-App (when at capacity)
- When a user tries to sign up but capacity is reached
- Graceful degradation: "We're at capacity, join the waitlist"
- Preserve their intent (what they were trying to do)

### 2. Waitlist Data Model

```sql
-- New table in bento-cloud (or identity schema)
CREATE TABLE waitlist_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  company TEXT,
  role TEXT,
  team_size TEXT, -- '1', '2-5', '6-20', '20+'
  use_case TEXT,
  source TEXT, -- 'landing', 'signup_blocked', 'referral'
  referrer_id UUID, -- for referral tracking
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'invited', 'joined', 'declined'
  position INTEGER, -- computed rank
  invited_at TIMESTAMPTZ,
  joined_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX waitlist_status_idx ON waitlist_entries (status);
CREATE INDEX waitlist_created_idx ON waitlist_entries (created_at);
```

### 3. Capacity Management

#### Global Capacity Flag
- Simple boolean in environment/config: `WAITLIST_ENABLED=true`
- When enabled, new signups are redirected to waitlist
- Admins can toggle via admin panel or environment variable

#### Wave-Based Onboarding
- **Batch size**: Configurable (e.g., 50-100 users per wave)
- **Frequency**: Daily, weekly, or manual trigger
- **Priority ordering**:
  1. Referrals from existing users
  2. Earlier signups (FIFO)
  3. Company size (larger teams first for enterprise sales)
  4. Use case alignment (high-value use cases)

### 4. Invitation Flow

```
1. Admin triggers wave (manual or scheduled)
2. System selects top N waitlist entries by priority
3. Status updated to 'invited', invited_at set
4. Invitation email sent with unique signup link
5. Link expires in 7 days (configurable)
6. User clicks link → lands on signup with pre-filled email
7. On successful signup: status → 'joined', joined_at set
8. If expired/declined: status → 'declined', back to pool or removed
```

### 5. API Endpoints (bento-cloud)

```
GET  /api/waitlist/status        - Check if waitlist is active
POST /api/waitlist/join          - Add email to waitlist (public)
GET  /api/waitlist/position/:id  - Check position (for invited users)
POST /api/waitlist/invite        - Admin: trigger invitation wave
GET  /api/waitlist/entries       - Admin: list waitlist entries
PATCH /api/waitlist/entries/:id  - Admin: update status manually
```

### 6. Admin Interface

#### Waitlist Dashboard (Settings → Waitlist)
- **Metrics**: Total signups, conversion rate, avg wait time
- **Filters**: Status, source, date range
- **Actions**: 
  - Trigger invitation wave (with batch size input)
  - Manual invite specific entries
  - Export to CSV
  - Toggle waitlist on/off

### 7. Email Templates

#### Waitlist Confirmation
```
Subject: You're on the Bento waitlist! 🎉

Hi [name],

Thanks for joining the Bento waitlist. You're position #[position] in line.

We're onboarding new teams in waves to ensure everyone gets a great experience. We'll email you when it's your turn.

In the meantime:
- Follow us on Twitter for updates
- Check out our docs to see what's coming
- Reply to this email if you have questions

The Bento Team
```

#### Invitation Email
```
Subject: Your Bento invite is here! 🚀

Hi [name],

You're off the waitlist! Click below to create your team:

[Accept Invitation Button] → expires in 7 days

This link is unique to you and can't be shared.

See you inside,
The Bento Team
```

### 8. Integration Points

#### With Existing Auth (better-auth)
- Waitlist check happens BEFORE signup
- In `sign-up/email` and `sign-up/social` hooks
- If waitlist enabled and user not invited → 403 with waitlist info

#### With Billing (bento-cloud)
- Invited users get Free plan by default
- Can upgrade immediately after signup
- Track waitlist → paid conversion funnel

#### With Analytics (PostHog)
- Event: `waitlist_joined` (email, source, position)
- Event: `waitlist_invited` (email, wave_id)
- Event: `waitlist_converted` (email, plan)
- Cohort: "Waitlist signups" for retention analysis

### 9. Edge Cases

| Scenario | Handling |
|----------|----------|
| Duplicate email | Return existing entry, don't create new |
| Invited user doesn't signup | Expire after 7 days, return to pool |
| Admin manually invites | Bypass priority, mark invited immediately |
| Waitlist disabled mid-wave | Complete current wave, stop new ones |
| User already has account | Redirect to sign in, don't add to waitlist |
| Referral tracking | Store referrer_id, prioritize referrals |

### 10. Implementation Priority

#### Phase 1: Core Waitlist (Week 1-2)
- [ ] Database schema + migrations
- [ ] Public API: join, status check
- [ ] Landing page form integration
- [ ] Confirmation email

#### Phase 2: Invitation System (Week 2-3)
- [ ] Admin API: list, invite wave
- [ ] Invitation email with unique links
- [ ] Signup flow integration (pre-filled, validation)
- [ ] Expiry handling

#### Phase 3: Admin Dashboard (Week 3-4)
- [ ] Waitlist page in Settings
- [ ] Metrics and filters
- [ ] Manual actions
- [ ] Export functionality

#### Phase 4: Analytics & Optimization (Week 4+)
- [ ] PostHog events
- [ ] Referral program
- [ ] A/B test waitlist copy
- [ ] Capacity auto-scaling signals

## Technical Considerations

### Database
- New table in bento-cloud (separate from open-source schema)
- No RLS needed initially (admin-only reads, public write only for join)
- Consider partitioning by status for large lists

### Security
- Rate limit `/api/waitlist/join` (10/hour/IP)
- Validate email format, sanitize inputs
- Unique signup links with signed tokens (JWT or random + DB lookup)
- Admin endpoints require owner/admin role

### Scalability
- Waitlist table stays small (<100k rows typically)
- Position calculation: `ROW_NUMBER() OVER (ORDER BY priority, created_at)`
- Cache position for 5 minutes to reduce DB load

### Testing
- Unit tests for priority scoring
- Integration tests for invitation flow
- E2E: join → invite → signup → onboard
- Load test: 10k concurrent joins

## Success Metrics

1. **Waitlist size**: Growing steadily = demand
2. **Conversion rate**: Invited → Joined > 40%
3. **Time to onboard**: Median days from join to invite
4. **Activation**: Joined → First agent run > 60%
5. **Revenue**: Waitlist → Paid conversion within 90 days

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Waitlist hurts growth perception | Transparent communication: "Ensuring quality" |
| Competitors capture demand | Fast waves, referral priority, clear timeline |
| Email deliverability issues | Use transactional email service, monitor bounces |
| Admin forgets to run waves | Automated daily cron with configurable batch size |
| Abuse (fake emails) | Email verification required before invite |

## Rollout Plan

1. **Internal dogfood**: Team joins waitlist, tests full flow
2. **Beta users**: Enable for existing beta-testers flag
3. **Public landing page**: Add waitlist form, measure signups
4. **Capacity trigger**: Enable when agent hours > 80% capacity
5. **Full launch**: Waitlist as default for new signups

---

*Generated during Product Investigation stage for "Add a waitlist to usebento.ai"*