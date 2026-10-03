# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker, `pearson-tfl/llm_wiki`.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## Additional repo labels

None of these is a triage state.

| Label         | Meaning                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `decision`    | A decision only John can take – one issue per decision. Applied with `ready-for-human`. |
| `blocked`     | Held on another ticket named in a comment; not walkable until it completes. Remove when that ticket completes. |
| `pm-pickup`   | A pending item the PM must read after context loss.                      |
| `consult`     | A reviewer consultation record – one issue per consultation. Never apply during triage. |
| `wayfinder:map`, `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task` | `/wayfinder`'s map and ticket types; `docs/agents/issue-tracker.md`, "Wayfinding operations". |

The GitHub defaults (`bug`, `documentation`, `duplicate`, `enhancement`, `good first issue`, `help wanted`, `invalid`, `question`) came with the fork and carry no workflow meaning here.
