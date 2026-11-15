# Fork maintenance

This fork keeps bounded fixes on top of upstream ZeroSub 1.2.1
(`2354700ad8749bebc3cff142190c37e1a7bd8999`). It preserves upstream's MIT license,
plugin ID `zerosub`, account storage layout and normal routing behavior.

## Changes

| Change | Reason and boundary |
| --- | --- |
| Trusted Gobstopper endpoint | Claude providers using exactly `http://127.0.0.1:8260` remain eligible for subscription routing. Other URLs, explicit credentials, alternate backends and custom account homes remain excluded. This is a deliberate local deployment policy, not a general promise that every proxy is trusted. |
| Windows session reload | Node cannot execute the npm `paseo.cmd` launcher directly through `execFile`. Invoke its sibling JavaScript entry point with the plugin's Node executable and separate arguments, without a shell. Refuse a missing entry point; other packaging layouts are not implied supported. |
| Compact-client sign-in | Mobile web reports platform `web`, so the former native-platform check offered a localhost callback on the wrong computer. Native and compact clients default to code sign-in; wide web clients retain browser sign-in and the explicit method switch remains available. |
| Mobile plugin startup | Hermes crashes when constructing the bundled client-store class during plugin activation. Use a closure factory with the same store API, polling and cleanup behavior. No account or server behavior changes. |
| Model-scoped quotas | Explicit Fable, Opus, Sonnet and Haiku quotas are recorded separately and evaluated against each agent's selected model. Shared rolling windows, budgets, sign-out and disabled state still exclude the account. No model is selected or changed by this fix. |
| Continuation context policy | A fresh continuation copies the source agent's resolved context policy and records its profile provenance. It does not re-resolve a mutable profile or copy environment credentials. This requires the daemon fork's optional snapshot fields and context-policy create support. |

The current plugin SDK exposes platform and compact layout, but no reliable
client/daemon locality. Wide tablet browsers and remote wide-desktop clients
may still need to select code sign-in manually. This fix does not establish
that every reported mobile problem is resolved. Account-header crowding and
host-picker behavior remain separate observations; no speculative UI redesign
is included.

## Validation

The existing dependency versions and lockfile are retained. The initial fork
passed all 114 Vitest tests, TypeScript checks, and the existing static mobile
API audit on Node 22. The added cases cover endpoint exclusions, native Windows
launcher handling and sign-in selection. The static audit detects forbidden
DOM usage; it is not a phone-rendering test.

The mobile-startup release passed all 118 tests and both TypeScript checks.
Its regression test executes store creation, polling startup and cleanup in the
Hermes interpreter already shipped with React Native on macOS. Other platforms
skip that interpreter check and still run the store behavior tests. The actual
Paseo 0.11.2 client bundle reproduced `Cannot read property 'prototype' of
undefined` while constructing the store. A rebuilt bundle using the same
compiler options activated all contributions and cleaned up under the same
Hermes engine with SDK stubs. Those stubs do not test rendering or device SDK
compatibility; physical-phone acceptance remains pending.

The two server fixes were already exercised in the native Windows deployment
before being moved into this fork. Verify plugin load after each source update.
Actual iOS/Android/browser interaction still needs a device check, and automatic
new-quota recovery or long-history continuation are not established by these
changes.

## Installation and rollback

Install a reviewed immutable commit or the fork tag, keeping plugin ID `zerosub`:

```sh
paseo plugin install git:ryaanahmed/zerosub --ref v1.2.1-ryaan.2
```

For an installation already using this fork, use the supported pinned update:

```sh
paseo plugin update zerosub --ref v1.2.1-ryaan.2
```

Before any update or replacement, record the current plugin source/revision and check that no
account sign-in is active. When changing source identity, Paseo 0.11.2 refuses an already-registered plugin ID:
run `paseo plugin remove zerosub` first, then the pinned install command above.
Paseo cleans up managed source directories, so the old installed path is not a
rollback artifact. Identify a reproducible source revision or preserve a source
archive before removal. Account storage is separate and remained intact on both
tested hosts.
Account state lives under `PASEO_HOME/zerosub`, separately from the installed
plugin source. Do not remove it, copy tokens between hosts or overwrite it with
an old snapshot merely to roll back code.

After replacement, confirm the plugin is running and account IDs/defaults remain
present. A plugin replacement does not require restarting the Paseo daemon or
reopening ordinary agents. Install a known-good source revision if the new source does not load.

Paseo's `--ref` chooses the initial Git content. Its later update action follows
the default branch, not that selector. Preview and review updates explicitly;
there is no automatic-update lock implied by this command.

The immutable server-fix baseline `9fa1f41efd5ab21e9396d1fd325544692f1ee7e2` contains the
previous Gobstopper and Windows behavior without the compact-client change. It
can be installed from this fork as a code rollback; it is not an account-state
snapshot. After recording the current source and confirming no sign-in is active:

```sh
paseo plugin remove zerosub
paseo plugin install git:ryaanahmed/zerosub --ref 9fa1f41efd5ab21e9396d1fd325544692f1ee7e2
```

Validate plugin load and account identities afterward. This rollback procedure
was not exercised against live accounts during the rollout.

## Maintain the fork

1. Fetch upstream changes and inspect them before merging.
2. Remove a fork patch once an equivalent upstream fix is accepted and verified.
3. Keep the endpoint trust policy explicit; generalizing it requires a separate
   configuration decision and tests for account exclusion.
4. Run the existing tests, TypeScript checks and static mobile audit.
5. Publish a new reviewed commit/tag and update one host before the other.
6. Record observed host/client behavior and unresolved limitations.

Do not publish this package under the upstream npm namespace. The fork is
installed from Git. Potential upstream contributions can be prepared as separate
changes; no upstream issue or pull request is opened automatically.


## Model quota repair

Account state version 1 and existing account IDs, bindings and sessions are retained.
Optional `modelLimits` records preserve each named model's reset across reloads;
optional `limitSource` distinguishes new shared usage marks from notices. Unknown
quota scopes and notices remain shared. Missing, cached, failed or readings older
than five minutes cannot create or repair persisted marks. Headroom and routing
use only the selected model's quotas plus shared quotas; the composer shows the
same model-specific availability, while account management retains shared status.

Legacy account-wide window marks are repaired automatically only when a fresh
reading has a full explicitly named model window whose reset exactly matches the
old mark, both shared Claude windows (`five_hour` and `seven_day`) are below 90%,
and the old mark has passed the existing fifteen-minute trust interval. Budget,
unknown-kind and new explicit shared notices are excluded from that repair.
Missing shared windows or reset timestamp differences require separate evidence
and a bounded operator reconciliation; this fix does not broadly clear them.

Paseo 0.15.4's session-open hook omits model selection. Existing agents are
refreshed for their selected model at routing and failover. Initial creation
runs before the daemon registers the agent, so a model may be unavailable;
unknown selection conservatively considers every model quota. A model override
supplied only to session reload is also invisible to this hook until the daemon
updates the snapshot. Resolving those SDK limitations requires a separate daemon
change. The ordinary model-selection command updates the snapshot and subsequent
routing uses that selection.


The quota repair passed 156 tests with one existing platform-dependent Hermes
check skipped on Linux, both TypeScript checks, and `audit:mobile` on Node
22.23.3. Coverage includes scoped versus shared exhaustion, live-budget
preservation, Opus failover, model changes on resume, unavailable creation
snapshots, idle peers on different models, reset inference, composer status and
conservative legacy repair. The pinned dependency install reported seven
existing audit findings (one moderate, three high, three critical); dependency
versions and the lockfile were not changed.
