# The path to other states

**Status: not built, and deliberately so.** Ohio is the only state in this
repository, and adding a second one is not in scope yet. This document exists so
that the Ohio work does not quietly foreclose the option — it records which
seams already generalize, which ones are Ohio-shaped today, and what to avoid
hard-coding in the meantime.

## What already generalizes

The round-2 schema work did most of the structural job:

- `elections` is a dated, typed collection, so additional elections of any
  `type` (`general`, `primary`, `special`, `local`) and `scope` have somewhere to
  live. Nothing assumes one election, and nothing assumes a November date.
- Every election already carries `jurisdiction_ids`. Today it is always
  `["ohio"]`, which is exactly the seam a second state would use.
- Contests carry their own `source_url` and `last_verified`, so provenance is
  per-contest rather than per-site. That does not change across states.
- `locations` map to `county_ids` rather than to a single county, and the
  interface asks the voter when a place spans more than one. County-crossing
  places are not an Ohio-specific problem, so that logic carries over.
- `hasPublishedBallotDetails()` separates "we know a date" from "we know the
  ballot". Most states publish schedules long before certified contests, so this
  distinction becomes more useful with more states, not less.

## What is Ohio-shaped today

These are the places a second state would actually touch. None of them is a
mistake — they are correct for a one-state pilot — but they are the real cost.

1. **One data file with one root `counties` registry.** `data/elections.json`
   has a single top-level `counties` object. Two states means either a
   per-state registry or namespaced county ids (`oh:franklin`). County names
   collide across states constantly: there is a Delaware County in Ohio,
   Indiana, Iowa, New York, Oklahoma and Pennsylvania.
2. **The validator reads exactly one file.** `scripts/validate-data.mjs` takes an
   optional path argument, so it is already close — it would need to iterate a
   set of state files and keep the alias namespace per state rather than global.
3. **Alias collisions become routine.** Alias uniqueness is currently enforced
   globally. "Columbus" is in Ohio, Georgia and Indiana; "Cleveland" is in Ohio
   and Tennessee. With a second state the resolver needs a state qualifier
   before it needs anything else, or it has to ask.
4. **Poll hours sit on the election.** `polls.open` / `polls.close` are
   per-election, but they are really a state-level fact that an individual
   election rarely overrides. That is harmless now and becomes duplication later.
5. **Ohio is written into the interface and the sources.** "Ohio only" in the
   search note, the `OH` brand mark, the hero's `· Ohio` suffix, and every
   Secretary of State URL. All of it is correct today; all of it is a per-state
   value tomorrow.

## The shape to move toward, when a second state is actually requested

```
data/
  ohio/elections.json
  <next-state>/elections.json
  states.json          # id, name, abbreviation, poll hours, official URLs
```

`locations` gain a `state` field, county ids get namespaced, the validator loops
over the state registry, and the resolver qualifies by state before matching
aliases. The interface reads the state's metadata instead of hard-coded strings.

That is a real afternoon of work, not a rewrite — which is the point of writing
it down now rather than building it.

## What to avoid in the meantime

Only two things, both cheap to honour:

- Do not add code that assumes the county registry is global. Read counties
  through the election/data object that owns them, not from a module-level
  constant.
- Do not add a second hard-coded Ohio string where an existing one can be
  reused. The ones listed above are already enough to find and replace.

Perfecting Ohio is the current goal. Coverage depth in Ohio counties is worth
more right now than breadth across states, because the hard problem this project
has — mapping a place a voter types to the ballot they will actually receive —
is a county-level problem that does not get easier by adding states.
