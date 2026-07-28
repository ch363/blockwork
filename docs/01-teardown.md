# Prison Architect: Freeplay Systems Teardown

Reference document for the Blockwork project. Scope is sandbox / freeplay only. Campaign, Escape Mode and Prisoner Mode are excluded except where they explain a shared system.

Sources are the official Paradox Prison Architect wiki (see Sources at the end). Numbers reflect the game as of the 1.x / "The Bucket" era including major DLC. Where a value is DLC-gated it is marked.

---

## 1. What freeplay is

A new sandbox prison starts from a plot of land, a delivery zone, a road, and a bank balance. There is no win condition. There are optional failure conditions, all toggleable at map creation.

**Map creation options that matter:**

| Option | Effect |
| --- | --- |
| Map size | Small / medium / large plot. Land can be bought outward later once Land Expansion is researched. |
| Gender | Male or female prison. No mixed prisons. Female prisons add babies, family cells, nurseries. |
| Continuous intake | On: a bus arrives whenever there is space. Off: you request prisoners manually via the Intake report. |
| Failure conditions | Riot, bankruptcy, deaths, escapes, warden deaths, re-offending paroles, wrongful executions. Each toggled independently. |
| Events | Random narrative events (virus outbreak, agitating radio, mass assassination attempt, workshop accidents, prisoner demands). |
| Mutators | "No contraband limits", "dynamic reputations", "criminally insane conversion", staff needs on/off, fog of war on/off, and similar. |
| Starting money | Preset tiers. |

The genuine design of freeplay is: **an economy engine wrapped around a needs simulation, gated by a research tree, pressured by a security simulation.** Everything else is surface.

---

## 2. Core loop

```
Accept grant / request intake
    -> build rooms and place objects (spend money)
        -> prisoners arrive and generate daily income
            -> needs decay -> misconduct -> danger -> riots / escapes / deaths
                -> spend on staff, security, programs to suppress that
                    -> reform + parole reduce re-offending, unlock grants and better prisoner classes
                        -> more money -> bigger prison -> repeat at higher difficulty
```

The tension the whole game runs on: **every prisoner is both revenue and risk.** Higher security categories pay more per day and are more likely to burn the place down.

---

## 3. Grid, construction and materials

- The world is a **square tile grid**. One tile is the atomic unit for everything: rooms, objects, pathfinding, utilities, fog of war.
- **Foundations** are the first thing built. A foundation creates an indoor building shell with walls and a floor. It must be a closed rectilinear region. Workmen physically walk to the site and build it over time, consuming delivered materials.
- **Walls, doors and windows** are placed on tile edges (conceptually) but occupy tiles in practice. Door types: normal door, jail door, staff door, solitary door, secure door, remote door (servo-driven).
- **Floor materials** change cost, cleaning behaviour and in some cases room grading. Concrete, tiles, marble, grass, dirt, road, running track, paving.
- **Wall materials** likewise: brick, concrete, perimeter wall, fence, plus "depressing" variants (slum, rusty, overgrown, derelict) that reduce room grade.
- Construction is **queued work, not instant**. Workmen carry materials from Storage. If Storage is empty, materials get ordered and arrive on a supply truck. This creates a real logistics chain even for building.
- **Clone / Quick Build** lets you copy a built region and stamp it elsewhere, paying full cost. This is the single biggest quality-of-life feature in the game and is always available.
- **Planning mode** lets you draw non-binding coloured lines and notes over the map to sketch layouts before committing money.

**Key insight:** construction is a resource-and-labour simulation, not a menu transaction. That is where a lot of the game's texture comes from, and also where most of its late-game lag comes from.

---

## 4. Rooms

Rooms are painted as rectangular-ish designations over floor tiles. A room becomes "functional" only when its minimum object and property requirements are satisfied. Requirements are checked continuously and a warning icon appears when unmet.

Room properties used as requirements: `Enclosed` (fully walled with no gaps, doors excluded from the designation), `Indoors` (inside a foundation), `Secure` (fenced or walled perimeter), `Outdoors`.

### 4.1 Full room list

| Room | Min size | Minimum requirements | Purpose |
| --- | --- | --- | --- |
| Cell | 2x3 (removable via Small Cells research) | Enclosed, Indoors, Bed, Toilet | Single-occupancy housing. Graded. |
| Dormitory | 2x3 | Enclosed, Indoors, Beds/Bunk Beds, Toilet | Multi-occupancy housing. Graded. |
| Family Cell | 4x4 | Enclosed, Indoors, Bed, Toilet, Crib, Shower Head | Female prisons, mothers with babies. Not graded. |
| Holding Cell | 5x5 | Enclosed, Indoors, Toilet, Bench | Overflow housing for unassigned prisoners. Not graded. |
| Solitary | none | Enclosed | Punishment cell. Generates suppression. |
| Padded Cell / Padded Holding / Padded Solitary (Psych Ward DLC) | as above | as above | Criminally Insane housing. |
| Canteen | none | Indoors, Serving Table, Table, Bench | Eating. Graded. |
| Kitchen | none | Indoors, Cooker, Fridge, Sink | Food production. |
| Shower | none | Shower Head | Hygiene. |
| Yard | 5x5 | Secure | Exercise, recreation. Graded. |
| Common Room | none | Indoors | Recreation, therapy programs. Graded. |
| Gymnasium (CFT DLC) | none | equipment | Exercise. Graded. |
| Classroom | 5x5 | Indoors, School Desk, Office Desk | Education programs. Graded. |
| Library | 5x5 | Indoors, Library Shelf, Sorting Desk | Literacy need, prisoner job. |
| Chapel | 6x6 | Indoors, Altar, Prayer Mat, Pews | Spirituality need, Spiritual Guidance program. |
| Workshop | 5x5 | Workshop Saw, Workshop Press, Table | Prison labour, license plates, carpentry. Contraband source. |
| Laundry | none | Indoors, Laundry Machine, Laundry Basket, Ironing Board | Clothing need. Prisoner job. |
| Cleaning Cupboard | 3x3 | Indoors | Janitor and prisoner cleaning supply. Auto-buys bleach. |
| Shop | 4x4 | Indoors, Table, Shop Front, Shop Shelves, adjacency | Luxuries need. Generates income. |
| Mail Room | 5x5 | Indoors, Table, Sorting Desk | Family/comfort/recreation need. Prisoner job. |
| Visitation | none | Indoors, Visitor Table (or Visitation Booth for secure) | Family need. Major contraband vector. |
| Nursery | none | Serving Table, Table, Bench, Crib, Play Mat | Female prisons. Baby needs. |
| Infirmary | none | Indoors, Medical Bed | Healing, overdose treatment, drug program. |
| Morgue | none | Indoors, Morgue Slab | Corpse storage until hearse pickup. |
| Execution | none | Indoors, Electric Chair | Death row executions. Legal research gated. |
| Parole Room | 5x5 | Indoors, Visitor Table | Parole hearings, death row appeals. |
| Reception | none | Indoors, Office Desk, Table, Chair | Intake processing. All arrivals searched here. |
| Security | 4x4 | Office Desk, Chair, Filing Cabinet | CCTV monitors, door control, phone tap. |
| Office | 4x4 | Indoors, Office Desk, Chair, Filing Cabinet | One per administrator. Required for research. |
| Psychiatrist Office (Psych Ward) | 4x4 | Office Desk, sofa, chair, Filing Cabinet | Psychiatric consultation. |
| Staff Room | 4x4 | Indoors, Sofa Chair Double, Drink Machine | Staff needs and rest. |
| Armoury | none | Indoors, Weapon Rack, Guard Locker, Table | Armed guards, tazers, stab vests. |
| Kennel | 5x5 | Enclosed, Dog Crate | Guard dog rest. |
| Forestry | 5x5 | Outdoors | Tree farming, wood income. Auto-buys trees. |
| Storage | none | none | Holds all delivered materials and goods. |
| Deliveries | 1x3 | none | Drop-off point for goods and prisoners. |
| Exports | 1x3 | none | Pickup point for manufactured goods. |
| Garbage | 1x3 | none | Trash collection point. |

**Design note:** the requirement system is elegant because it is declarative. A room is a set of predicates over its tiles and contained objects. This is trivially data-driven and should be replicated.

### 4.2 Room grading

Seven room types carry a numeric quality grade. Grades feed **sector grading** and the **cell entitlement** system.

Graded rooms: Cell, Dormitory, Yard, Gymnasium, Common Room, Classroom, Canteen.

**Cell grading, scale 0 to 10 (0 to 15 with Cleared for Transfer DLC):**

- +1 each for: large window, office desk, chair/leather chair/stool, TV or large TV, radio, bookshelf, shower head, pet bird, soft pillow, sink and mirror, canvas and paints, punch bag, comfy bed
- -1 each for: old bed, foam mattress, depressing wall materials (slum, rusty, overgrown, derelict)
- Size: +1 if at least 6 tiles, +2 if at least 9 tiles, +3 if at least 16 tiles
- Windows: +2 if at least one outdoor-facing window, -1 if no windows at all
- -1 if a PA system exists anywhere in the cell block

**Dormitory grading:** same idea but "one object per 4 prisoners" scaling. Windows bonus needs one outdoor window per 8 prisoners. -1 if the majority of beds are low quality.

**Yard grading:** +1 each for dumbbell rack, bleachers, punch bag, tyre apparatus. -1 for PA system. Size: +1 at 100 tiles, +2 at 200 tiles, -1 at 50 tiles or fewer. +2 if the yard has at least 10 positive objects. +1 for at least 12 tiles of running track. -1 if 50% or more is mud.

**Canteen grading:** +1 each for fan, 4x plants, water cooler, drink machine, snack machine. -1 for CCTV camera. +2 for high quality meals, +2 for high variety meals. +1 if at least 20 tiles. -1 if no windows.

**Classroom grading:** +1 per 6 school desks, +1 per 2 bookshelves, +1 water cooler. +1 at 25 tiles, +2 at 50 tiles. +2 for two outdoor-facing windows. +2 instead of +1 if at least 10 school desks. +2 for a blackboard.

**Common Room grading:** +1 each for phone booth, TV, pool/tennis/football table, chess table, radio, arcade cabinet, snack machine. -1 for CCTV. +1 at 25 tiles, +2 at 50 tiles. +2 for at least 4 computer stations.

**Gym grading:** +1 per 6 treadmills, per 6 weights benches, per 4 gym mats, plus punch bag, boxing ring, fan, water cooler, dumbbell rack. +1 at 60 tiles. +2 for 4 outdoor windows, -1 for none.

**Cell entitlement mechanic:**

- Every day of good behaviour earns a prisoner **1 point of cell quality entitlement**.
- Misconduct resets entitlement to 0.
- Guards periodically reshuffle cell assignments to match entitlement to grade. Strictness is set in Policy.
- New arrivals are entitled to an "average" cell.
- Prisoners in below-average cells are **more likely to misbehave**. Above-average cells make them **less likely**, because they want to keep the room. If all cells are identical, the modifier is neutral.

This is one of the smartest systems in the game and is badly under-explained in the UI.

---

## 5. Objects, utilities and logistics infrastructure

### 5.1 Objects

Objects are placed inside rooms and either satisfy room requirements, satisfy needs, produce or consume resources, or provide security. Every object has: cost, size in tiles, whether it needs power, whether it needs water, which rooms it counts for, which needs it serves, and whether it is a contraband source.

### 5.2 Electricity

- **Power Station** produces a base load. **Capacitors** attached to it increase capacity. **Capacitor 2.0** gives double output at double price.
- Power flows through **electrical cables** laid in the Utilities view.
- The station has an **overcharge protection** trip: if demand exceeds capacity, the station shuts off and must be manually reset by a workman.
- **Multiple power stations must be on separate circuits.** Connecting two stations collapses both grids. (This is a bug-shaped feature that players find infuriating.)
- **Power Switches** placed on a cable let you cut a branch, so unbuilt wings do not draw power.

### 5.3 Water

- **Water Pump Station** supplies water. It must be directly powered.
- **Large Pipes** carry the main flow, **Small Pipes** distribute to individual objects.
- Toilets, sinks, shower heads and drains need water.
- **Pipe Valves** cut a branch, same as power switches.
- Hot water and radiators feed the Warmth need in cold climates.

### 5.4 Wired objects

Wiring is a separate manual "Connect" mode. CCTV cameras connect to CCTV monitors. Servos connect to Door Control Systems. Phone booths connect to Phone Taps. Door Timers, Pressure Pads, Logic Circuits, Logic Bridges and Status Lights compose into a genuinely usable logic system for automated door sequences and sally ports.

**Direction matters:** connecting A to B is not the same as B to A. Connecting a power switch to a status light makes the light report the switch. The reverse makes the light control the switch.

### 5.5 Logistics

The Logistics view exposes four things:

1. **Food distribution** (needs Micromanagement research): which kitchens serve which canteens. Without it, the game auto-assigns by proximity, badly.
2. **Laundry distribution**: which laundries serve which cell blocks.
3. **Prison labour**: assign prisoners to jobs in the kitchen, laundry, cleaning cupboard, workshop, library, mail room, shop, forestry. Requires Prison Labour research.
4. **Room quality**: the grid view of every graded room's current grade and its occupant's entitlement.

**The food chain, in full:** supply truck delivers ingredients to Deliveries -> workmen move to Kitchen fridges -> cooks begin preparing 4 hours before a scheduled Eat block -> cooked meals move to the canteen Serving Table -> prisoners queue and eat -> dirty trays return to the kitchen sink -> cooks wash up -> waste goes to Garbage -> a truck collects it. Every hop is a real agent walking a real path. Break any link and prisoners starve.

**Laundry chain:** dirty uniforms accumulate on beds -> laundry-assigned prisoners or janitors collect into laundry baskets -> washed in laundry machines -> ironed -> distributed back to beds.

**Cleaning:** dirt accumulates on floor tiles from foot traffic, blood, urine, food waste. Janitors clean indoors, gardeners clean outdoors, prisoners assigned to the cleaning cupboard clean during Work time. Dirty floors raise the Environment need for everyone in the room.

---

## 6. Prisoners

### 6.1 Risk categories

| Category | Intake fee | Daily income | Notes |
| --- | --- | --- | --- |
| Minimum Security | $300 | $100 | Passive. No dangerous traits or reputations. Will not initiate fights. Rarely joins gangs. Short sentences, frequent release. |
| Medium Security | $500 | $150 | Moderate risk. Will kill snitches and ex-law-enforcement. Some reputations. |
| Maximum Security | $1,000 | $250 | High risk. More legendary traits, more gang lieutenants, long sentences, escalates fast, kills. |
| Super Max | $2,000 | $250 | Manual designation or transfer only. Intended for 23-hour lockdown. |
| Protective Custody | none | $200 | Manual only. Segregation for snitches, ex-cops, blown informants, addicts in withdrawal, infected prisoners. |
| Death Row | $2,500 | $300 | Transfer only, requires Death Row research. Unlimited sentence. Follows no regime. Appeals process. |
| Criminally Insane (Psych Ward DLC) | $3,000 | $300 | Requires padded facilities. Regular prisoners can convert if needs are ignored long enough. |

Auto-reclassification: causing a serious injury bumps the category up one level. Committing murder forces Maximum Security and adds a 25 year sentence.

### 6.2 Hidden traits

Every prisoner carries hidden behavioural traits derived from their convictions. These, not the risk category, actually drive behaviour.

`Clever` (digs tunnels, wants Literacy), `Controlling` (wants a private cell, hates shakedowns), `Destructive` (breaks objects in riots), `Fraud`, `Lethal` (kills intentionally), `Loyal` (dies for gang), `Narcotics` (drug/alcohol needs, addiction-prone), `Petty` (hoards contraband), `Risks Life` (unafraid of guards, frequent escape attempts), `Theft` (steals contraband), `Vehicular` (steals trucks), `Violent` (starts fights), `Sexual`, `Young`.

### 6.3 Reputations

Visible only if known on arrival, or revealed by Confidential Informants or Phone Taps.

`LEGENDARY` (multi-trait apex predator, always max/supermax/death row, often gang leader), `Strong` / `Extremely Strong`, `Tough` / `Extremely Tough`, `Volatile` / `Extremely Volatile`, `Stoical` (immune to solitary suppression), `Snitch` (target), `Deadly` / `Extremely Deadly` (one-hit kills), `Ex Law Enforcement` / `Ex Prison Guard` (target), `Cop Killer` (guards brutalise him), `Fearless`, `Quick` / `Extremely Quick`, `Instigator` (nearby prisoners copy his misconduct), `Skilled Fighter` / `Expert Fighter` (disarms opponents), `Gang Member`, `Preacher` (converts others, spreading the Spirituality need), `Supplier`, `Dealer`, `Green Thumb`, `Foodie`.

Reputations are fixed for the run unless the Dynamic Reputations mutator is on. Gang allegiance and Snitch status can change.

### 6.4 Crimes and sentences

Sentences are the clock that decides when a prisoner leaves. **One year of sentence equals 120 in-game hours, which is 5 in-game days.**

Representative sample (full table in the source wiki, roughly 45 crimes):

| Crime | Min yrs | Max yrs | Risk | Traits granted |
| --- | --- | --- | --- | --- |
| Vandalism | 1 | 2 | Low | Destructive, Young |
| Shoplifting | 2 | 10 | Low | Theft, Petty |
| Fraud | 2 | 10 | Low | Fraud |
| Money Laundering | 5 | 14 | Low | Fraud, Clever |
| Possession | 2 | 7 | Medium | Narcotics |
| Assault | 1 | 10 | Medium | Violent |
| Car Jacking | 5 | 15 | Medium | Theft, Vehicular, Young |
| Rioting | 5 | 10 | Medium | Violent, Destructive |
| Arson | 15 | 25 | Medium | Risks Life |
| Aggravated Assault | 10 | 15 | High | Violent, Risks Life |
| Armed Robbery | 15 | 25 | High | Theft, Risks Life |
| Torture | 5 | 15 | High | Violent, Controlling |
| Murder | 25 | 25 | High | Violent, Lethal |

Prisoners can carry multiple convictions. The biography also records guilty/not-guilty pleas, which matters for parole and death row appeals.

### 6.5 Status effects

`Angry` (parole denied), `Bleeding`, `Calming` (post-Spiritual Guidance aura, spreads to neighbours), `Drunk`, `Exposure` (cold), `Food Poisoning`, `High`, `Overdosed` (lethal without a doctor), `Overheating`, `Riled Up`, `Sick` (contagious), `Suppressed`, `Surrendered`, `Tazed`, `Well Fed` (all needs met, contributes to Health grading, reduces misconduct), `Withdrawal`.

### 6.6 Misconduct types

Contraband found (weapons / drugs / tools / luxuries), Complaint, Intoxication, Escape Attempt, Destruction, Attacked Prisoner, Attacked Staff, Serious Injury, Murder.

**Punishment:** Policy maps each misconduct type to a punishment (ignore / cell lockdown / solitary) and a duration. Discretionary punishment via the rap sheet allows up to 24 hours of either, or permanent once Permanent Punishments is researched.

**Suppression accrual:** +1 per half hour on cell lockdown, +1 per quarter hour in solitary. Decays at 1 per hour after release. Suppressed prisoners misbehave less but learn less, refuse programs, and are miserable. Stoical prisoners do not accrue suppression from solitary.

Prisoners in lockdown or solitary get meals delivered, so they do not starve.

### 6.7 Prisoner grading (rap sheet)

Four grades per prisoner: **Punishment**, **Reform**, **Security**, **Health**. These aggregate into an **Estimated Re-Offending Chance** which is the game's real long-term score. Active addictions push it up hard. Completed programs push it down.

---

## 7. Needs

Needs are the beating heart of the sim. Each need is a 0 to 100 value that fills over time and is discharged by performing a specific activity in a room that supports it.

Display bands: Satisfied (green), Medium (yellow), High (orange), Critical (red), Active (blue, currently being discharged).

### 7.1 Prisoner needs

| Need | Discharged by | At critical |
| --- | --- | --- |
| Bladder | Toilet in the current room or their cell | Urinates on the floor, creating a mess |
| Bowels | Same as bladder, satisfied simultaneously | Soils uniform |
| Sleep | Bed or bunk bed during Sleep or Free Time. Prisoners never sleep 8am to 8pm regardless of regime | none |
| Food | Serving table in a canteen during Eat time | Starvation timer, then death |
| Hygiene | Shower head with running water | none |
| Clothing | Clean uniform from bed before showering, supplied by the laundry chain | none |
| Comfort | Any bed, bench or chair in the current room. Reading mail helps | none |
| Exercise | Yard laps or weights bench | none |
| Safety | Guard presence and low danger level | Seeks a contraband weapon, flees threats |
| Freedom | Free time, unlocked doors, arcade cabinet | Steals a tool and starts an escape tunnel during Sleep |
| Family | Phone booth, visitation, mail | none |
| Recreation | Pool table, TV, radio, common room, mail | none |
| Environment | Clean floors | none |
| Privacy | Time alone in their own cell, or solitary. Not all prisoners have this need | none |
| Literacy | Library books or bookshelves. Mostly Clever prisoners | none |
| Spirituality | Spiritual Guidance program in a chapel. Spread by Preacher reputation | none |
| Drugs | Narcotics contraband, or Pharmacological Treatment | Withdrawal, vomiting |
| Alcohol | Booze contraband, or Alcoholics Group Therapy | Withdrawal, vomiting |
| Warmth | Radiators, indoor time | Exposure damage |
| Luxuries | Shop purchases, cigs, mobile phones | none, purely upside |

Female prisons add `[Baby] Sleep` (crib) and `[Baby] Play` (play mat) to mothers.

**Critical behaviour:** unmet needs drive complaints, then destruction, then violence, then riots. Not all needs escalate to violence. Clothing and Comfort notably do not.

If nothing is provided, prisoners still act: no toilet means urinating on the floor, no bed means sleeping where they stand.

### 7.2 Addictions

Prisoners arrive addicted, or develop addictions from using drugs out of boredom (unmet Recreation or Comfort). Addiction strength grows with each use, and overdose chance scales with it. Untreated overdose is fatal. Only a Doctor can save them. Treatment programs suppress the need but it returns if treatment stops. Successfully completed withdrawal permanently reduces the desire.

**Active addictions have a strong negative effect on re-offending chance.** This is the main link between the needs sim and the long-term score.

### 7.3 Staff needs (optional mutator)

Bladder, Bowels, Rest, Food, Comfort, Safety, Recreation, Environment, Warmth.

Staff satisfy needs only during break times, and only in staff-accessible rooms (staff room, staff-only canteen, storage, security, armoury, kennel, offices, or any staff-only sector).

**Consequences of neglected staff:**
- Walk slowly
- Search for contraband less effectively
- Ignore trouble
- Refuse to confront dangerous prisoners
- Accept bribes to overlook contraband
- Raise the prison-wide Danger level

**Staff morale** is a prison-wide value affected by staff happiness, long-term staff deaths, current injuries and salary. At 0% morale staff strike and demand a raise. Strikes always end after 24 hours and are not a failure condition, but waiting them out makes future strikes far more likely.

---

## 8. Staff

### 8.1 Roster

**Administrators** (each needs their own Office, each unlocks research):
Warden, Chief, Accountant, Foreman, Psychologist, Lawyer.

**Guards and security:**
Guard, Armed Guard (needs Guard Locker each), Dog Handler + Guard Dog, Sniper (in Guard Towers), Riot Guard (emergency call-in), Soldier / National Guard (emergency call-in), Orderly (Psych Ward DLC).

**Support:**
Workman, Janitor, Gardener, Cook, Doctor, Teacher, Psychologist, Psychiatrist (Psych Ward), Spiritual Leader, Parole Lawyer, Parole Officer, Appeals Lawyer, Appeals Magistrate, Paramedic, Fireman.

Some staff are permanent hires with a daily wage. Others (teacher, spiritual leader, parole officials) are external and are paid per session.

### 8.2 Guard behaviour

- Guards remove fog of war in a radius.
- Guards escort prisoners: to cells, to solitary, to the infirmary, to programs, to reception.
- Guards perform searches: on individuals, cells, or whole blocks, either manually, automatically via Policy on misconduct, or en masse via Shakedown.
- Guard presence in a room drastically reduces the chance of a prisoner stealing from it.
- Guards do not proactively notice theft. They only find contraband on an explicit search.
- Guards can be **stationed** to a specific sector or object (via Deployment) or set on **patrol routes** (via Patrols research).
- Search effectiveness scales with staff morale.

---

## 9. Regime

The daily schedule, set per risk category, in one-hour blocks across 24 hours.

| Activity | Behaviour |
| --- | --- |
| Lockup | Confined to cell, not forced to sleep, uses in-cell objects. Raises Freedom need and suppression. |
| Sleep | Confined to cell. Prisoners will not sleep 8am to 8pm regardless. Five hours is the practical floor. |
| Eat | Report to canteen (or nursery). Cooks start preparing 4 hours in advance. Scheduling consecutive Eat hours doubles food production and wastes it. |
| Yard | Optional trip to the yard. |
| Shower | All prisoners head to the nearest shower. |
| Free Time | Prisoners self-direct. Spreads them out, which reduces violence. Cooks do not cook, so no eating. |
| Work / Free Time | Assigned jobs and programs run. Unassigned prisoners behave as Free Time. |
| Work / Lockup | Same, but unassigned prisoners are locked up. |
| Programs / Free Time (Psych Ward) | Criminally insane attend psychiatric programs. |

**Outside the regime:** visitation is always 8am to 8pm. Injured prisoners always go to the infirmary if allowed out. Parole hearings and death row appeals can be scheduled at any hour. Death row prisoners follow no regime at all. Mothers prioritise their babies over the regime.

Programs are auto-scheduled into Work blocks only. A three-hour program needs a three-hour contiguous Work block or it will never run. Micromanagement research unlocks manual pinning.

---

## 10. Deployment and sectors

The Deployment view divides the prison into **sectors** (contiguous regions bounded by doors and walls) and lets you set access and staffing.

**Sector access modes:** Staff Only, Secure (prisoners allowed, doors locked), Shared, Unlocked.

**Security sector designation:** a sector can be restricted to a single risk category (min / med / max / supermax / protective custody / death row / criminally insane). Prisoners of other categories will not path into it. This is how segregation works.

**Staffing:** stationed guards, patrol routes for guards / dog handlers / armed guards, and (with Micromanagement) time-of-day schedules so you can flood the canteen during Eat and the yard during Yard.

**Sector grading (CFT DLC):** a sector's grade is the aggregate of its graded rooms. Prisoners with high entitlement get moved to better-graded sectors. This creates a visible reward ladder: behave, and you get moved to the nice wing.

---

## 11. Bureaucracy (the research tree)

Unlocked by hiring a Warden. Each research costs money and takes in-game time. Each administrator must have their own functional Office before they can research.

### 11.1 Warden main tree

| Research | Cost | Time | Unlocks |
| --- | --- | --- | --- |
| Security | $500 | 6h | Security room, Deployment view, Danger meter, the Chief, Security sub-tree |
| Psychology | $500 | 6h | Needs report, the Psychologist, Behavioural Therapy, Alcoholics Group Therapy |
| Health | $500 | 6h | Infirmary, Morgue, Medical Bed, Morgue Slab, the Doctor, drug treatment program |
| Education | $2,000 | 12h | Classroom, School Desk, Foundation Education, General Education Qualification |
| Legal | $5,000 | 12h | The Lawyer, Legal sub-tree |
| Maintenance | $500 | 6h | The Foreman, Maintenance sub-tree |
| Finance | $500 | 6h | Finance and Valuation reports, share trading, prison selling, the Accountant, Finance sub-tree |
| Prison Policy | $1,000 | 6h | Policy report, nutritional policy (meal quantity and variety) |
| Micromanagement | $1,000 | 6h | Deployment scheduler, program scheduler, canteen logistics, laundry logistics |

### 11.2 Security sub-tree (Chief)

| Research | Cost | Time | Unlocks |
| --- | --- | --- | --- |
| Surveillance | $2,000 | 6h | CCTV Camera, CCTV Monitor, Phone Tap |
| Deployment | $1,000 | 6h | Station guards in sectors |
| Intelligence | $1,000 | 6h | Intelligence view, contraband report, Confidential Informants, gang visibility |
| Patrols | $1,000 | 6h | Guard patrol routes |
| Dogs | $1,000 | 6h | Kennel, Dog Crate, Dog Handler, Guard Dog. Requires Patrols |
| Remote Access | $2,000 | 6h | Door Control System, Servo, Logic Circuit, Logic Bridge, Door Timer, Pressure Pad, Status Light |
| Armoury | $2,000 | 12h | Armoury, Guard Locker, Weapon Rack, Armed Guard |
| Tazers | $1,000 + $400/tazer | 6h | Armed guards carry tazers |
| Tazer Rollout | $5,000 + $400/tazer | 12h | Regular guards carry tazers after certification program |
| Body Armour | $1,000 + $100/vest | 6h | Stab vests: -50% damage taken, -30% movement speed |
| Guard Towers | $5,000 | 18h | Guard Towers, Snipers |

### 11.3 Legal sub-tree (Lawyer)

| Research | Cost | Time | Unlocks |
| --- | --- | --- | --- |
| Small Cells | $10,000 | 24h | Removes the 2x3 cell minimum |
| Permanent Punishments | $5,000 | 24h | Indefinite lockdown and solitary |
| Death Row | $10,000 | 24h | Execution room, death row appeals |
| Reduce Execution Liability | $10,000 | 72h | Allowed clemency chance at execution raised to 10% |
| Legal Prep | $50,000 | 72h | Prerequisite for Legal Defense |
| Legal Defense | $50,000 | 3h | Cancels one Game Over event |

### 11.4 Maintenance sub-tree (Foreman)

| Research | Cost | Time | Unlocks |
| --- | --- | --- | --- |
| Prison Labour | $1,000 | 6h | Workshop, Laundry and their machines, prisoner job assignment, room quality view, workshop and kitchen safety programs, carpentry apprenticeship |
| Cleaning | $2,000 | 6h | Cleaning Cupboard, Janitor |
| Grounds Keeping | $2,000 | 6h | Forestry, Gardener |

### 11.5 Finance sub-tree (Accountant)

| Research | Cost | Time | Unlocks |
| --- | --- | --- | --- |
| Tax Relief | $10,000 | 2 days | Tax reduced to 15% |
| Offshore Tax Haven | $50,000 | 2 days | Tax reduced to 1%. Requires Tax Relief |
| Bank Loan | $500 | 12h | Loans, credit rating |
| Extra Grant | $500 | 6h | Third concurrent grant |
| Land Expansion | $1,000 | 12h | Buy adjacent land in any direction, repeatedly |

---

## 12. Programs and reform

Programs run in Work regime blocks (except parole hearings, death row appeals and guard tazer certification, which run any time). One program per prisoner at a time, one session per day. Cost is per session regardless of attendance, so half-empty classes are a money sink.

| Program | Cost/session | Seats | Sessions | Tutor / room | Length | Attendance |
| --- | --- | --- | --- | --- | --- | --- |
| Alcoholics Group Therapy | $200 | 20 | 10 | Psychologist / Common Room | 2h | Referred (alcoholism) |
| Pharmacological Treatment of Drug Addiction | $200 | 10 | 3 | Doctor / Infirmary | 1h | Referred (addiction) |
| Behavioural Therapy | $200 | 1 | 5 | Psychologist / Office | 2h | Referred (violence) |
| Workshop Safety Induction | $100 | 10 | 2 | Foreman / Workshop | 2h | Voluntary |
| Carpentry Apprenticeship | $500 | 5 | 5 | Foreman / Workshop | 2h | Voluntary, requires Workshop Safety |
| Kitchen Safety and Hygiene | $100 | 5 | 2 | Cook / Kitchen | 2h | Voluntary |
| Foundation Education | $300 | 20 | 5 | Teacher / Classroom | 3h | Voluntary |
| General Education Qualification | $500 | 10 | 10 | Teacher / Classroom | 3h | Voluntary, requires Foundation |
| Spiritual Guidance | $250 | 20 | 1 | Spiritual Leader / Chapel | 2h | Voluntary (Spirituality need) |
| Parole Hearing | $0 | 1 | 1 | Parole Lawyer + Officer / Parole Room | 4h | Parole queue |
| Death Row Appeal | $0 | 1 | 1 | Appeals Lawyer + Magistrate / Parole Room | 4h | Death row |
| Psychiatric Consultation (Psych Ward) | $150 | 1 | 1 | Psychiatrist / Psychiatrist Office | 1h | Referred (suppression) |
| Gang Rehabilitation (Gangs DLC) | $150 | 1 | 2 | Psychologist / Office | 1h | Referred |
| Guard Tazer Certification | $100 | 10 | 1 | Chief / Classroom | 1h | Mandatory staff |
| Disarming Certification (Gangs) | $100 | 10 | 3 | Chief / Classroom | 1h | Mandatory staff |

**Success factors:** concentration (all needs met), affinity for academic topics, and suppression. Suppressed prisoners rarely volunteer and often fail. Gang members refuse voluntary programs entirely. Death row prisoners follow no regime so they attend nothing.

Prisoners must complete Workshop Safety or Kitchen Safety before being assigned those jobs.

**Parole:** hearings are free, so schedule as many as possible. Success depends on reform grade, misconduct history, time served and program completion. A denied parole makes the prisoner Angry. A granted parole releases them early. If they re-offend, it counts against you and can end the game.

---

## 13. Contraband and intelligence

### 13.1 Categories

**Weapons** (attack power in HP, recharge in in-game minutes):

| Item | Attack | Recharge | Source |
| --- | --- | --- | --- |
| Fists | 0.75 | 1.5m | always available |
| Dog bite | 0.75 | 1m | guard dogs |
| Baton | 1.5 | 1.5m | downed guards, Security room, Armoury |
| Club | 1.5 | 1.5m | crafted in Cleaning Cupboard or Gymnasium |
| Scissors | 1 | 1m | Infirmary, Morgue, Library |
| Fork | 3 | 2m | Kitchen, Staff Room |
| Knife | 6 | 3m | Kitchen, Morgue, Staff Room |
| Shank | 9 | 3m | crafted in Workshop |
| Fountain Pen | 9 | 3m | Office, Library, Parole Room |
| Shears | 10 | 4m | Forestry |
| Gun | 15 | 0.5m | Armoury. Range 10, 70% accuracy, 6 rounds |
| Shotgun | 25 | 1m | downed armed guards, Armoury. Range 10, two-handed |
| Rifle | 50 | 2m | downed snipers, Armoury. Range 40, two-handed |
| Assault Rifle | 4 | 0.1m | downed soldiers. Range 20, 30 rounds |
| Tazer | 1 + stun | 1h | downed guards, Armoury |

**Tools** (escape enablers): Spoon, Saw, Screwdriver, Hammer, Drill, Torch, Wooden Pickaxe (crafted), Axe, Spade, Rope (fence climbing, multi-prisoner), Jail Keys (opens doors during riots), Sedative Syringe.

**Narcotics:** Needle, Poison, Drugs, Medicine. Most are "smelly" and detectable by dogs.

**Luxuries:** Booze, Cigs, Mobile Phone, Lighter (starts fires), Gold Pocket Watch.

### 13.2 How contraband gets in

1. **Arrivals** almost always carry something off the bus.
2. **Visitation** family smuggling, unless you use Visitation Booths instead of Visitor Tables.
3. **Deliveries**: ingredients, sheet metal, uniforms, shop goods and construction materials can all be spiked.
4. **Stealing from rooms.** Crucially, **the room is the contraband source, not the object.** An empty Armoury still yields guns. A Weapon Rack in the yard is completely safe. This is a deliberate abstraction.
5. **Crafting**: shanks and wooden pickaxes in the Workshop, clubs in the Cleaning Cupboard and Gymnasium.
6. **Throw-ins** over the perimeter, arranged by phone or in visitation, landing within 10 tiles of the boundary (walls block).

### 13.3 Trading economy

Prisoners trade contraband with each other for money. Prices float on in-prison supply and demand. Prisoners steal items they do not personally want purely to sell. Money buys shop goods, gang protection, and other contraband. The Intelligence / Dangers view shows live prices, supply and demand.

### 13.4 Detection

- **Reception room**: all arrivals systematically searched. Costs guard time and slows intake.
- **Metal detectors** on doorways: metal only, not 100%, expensive, power-hungry.
- **Guard dogs**: smelly items only.
- **Manual searches**: prisoner, cell, or whole block. Always find everything.
- **Policy-automated searches** on misconduct.
- **Shakedown**: prison-wide search. Finds a lot, enrages everybody.
- **Confidential Informants**: recruited prisoners who reveal hidden contraband locations, arranged throw-in spots, hidden reputations and gang membership. Blown informants become assassination targets.
- **Phone taps**: reveal arranged throw-ins and hidden reputations.

Search effectiveness scales with staff morale. Pissed-off guards miss things and take bribes.

---

## 14. Emergencies and failure states

### 14.1 Danger level

A prison-wide meter (visible once a Chief is hired) aggregating unmet needs, recent misconduct, suppression, staff morale and armed prisoner count. High danger makes prisoners seek weapons (Safety need) and raises escape and riot probability.

### 14.2 Riots

Triggered by a critical mass of angry prisoners, often kicked off by an Instigator or a specific event. During a riot prisoners attack staff, destroy objects, take hostages, break into rooms and attempt mass escape. Destructive prisoners cause disproportionate damage.

**Response tools:** Lockdown (all doors locked), Bangup (all prisoners to cells), Freefire (armed guards shoot without warning), Riot Guards and Soldiers called in from the Emergencies menu, tear gas from a Door Control System.

**Failure:** a riot running for 6 in-game hours triggers a warning. You then get another 6 hours. After that the National Guard retakes the prison by force, killing anyone still aggressive, and you are fired.

### 14.3 Escapes

Escape routes: through unlocked or breached doors, over fences (with rope, or unassisted if Extremely Strong), through walls broken during riots, via stolen vehicles (Vehicular trait), and by **escape tunnels**.

**Tunnels:** dug by Clever prisoners with a tool, during Sleep regime, starting from a toilet in a cell. They progress a little each night. Guard dogs sniff tunnel entrances and place flags. Searching the cell finds and collapses it. Tunnels can connect between cells, letting multiple prisoners share one route. This is the most-loved emergent system in the game.

### 14.4 Fires

Started by lighters, workshop accidents, or electrical faults. Spread tile to tile. Firemen are called from Emergencies. Fires destroy objects and kill anyone caught. Sprinklers (water-connected) fight them automatically.

### 14.5 Other events

Virus outbreak (contagious Sick status, potentially lethal), Agitating Radio (Riled Up status), Mass Assassination attempt, Workshop Accident (Bleeding), Prisoner Demands (they want more free time or less work, refusing angers them), Cold Snap.

### 14.6 Failure conditions

All optional at map creation. Each gives a warning call from the CEO before the actual game over. Legal Defense research cancels one game over per run.

| Condition | Trigger |
| --- | --- |
| Riot | Riot uncontained for 6 hours, then 6 more |
| Bankruptcy | Negative balance and negative cash flow, 24 hours to fix |
| Deaths | 20 deaths in one day, then 5 more the next day. Player is imprisoned in their own prison |
| Escapes | 20 escapes in one day, then 5 more the next day |
| Warden Deaths | Too many wardens killed, then one more |
| Re-offending Paroles | Too many paroled prisoners re-offend |
| Wrongful Executions | Executing prisoners above the state clemency tolerance, twice, then again |

---

## 15. Economy

**Income:**
- Per-prisoner intake fee on arrival ($300 to $3,000 by category)
- Per-prisoner daily payment ($100 to $300 by category), paid at midnight
- Grants (advance plus completion bonus)
- Workshop and forestry exports
- Shop revenue
- Share sales, and ultimately selling the whole prison

**Expenditure:**
- Construction materials and object purchases
- Staff wages (hourly)
- Program session fees
- Research costs
- Bills: power, water, garbage collection
- Loan interest (hourly)
- Tax (default rate, reducible to 15% then 1%)
- Fines for failed grant conditions

**Grants:** up to two concurrent (three with Extra Grant research). Structure is advance payment plus completion bonus, with a to-do checklist. Cancelling refunds the advance plus a 10% fine.

Starting grants: Basic Detention Centre ($20k + $10k), Administration Centre ($5k + $5k), Health and Well Being ($10k + $10k), Reform through Education ($15k + $40k), Staff Well-being ($0 + $10k).

Locked grants unlock on prerequisites: Cell Block A, Prison Maintenance, Visitation Rights, Security Procedure Certification, Governmental Security Ratings, Max-Sec Infrastructure, Prisoner Acclimatization, Prison Manufacturing Facility, Carpentry Apprenticeship, Inmate Nutrition Research, Crackdown on Drugs, Tool Cleanup.

Hidden grants: Government Bailout ($50k + $50k, once per game, appears when near bankruptcy), Cell Blocks B through E, short and long term investment funds.

**Loans:** require an Accountant and Bank Loan research. Hourly interest. Successful payments raise credit rating, which raises the borrowing cap from $2,500 up to $250,000. Missed payments destroy the rating. The principal is never repaid by interest alone, you must actively repay it.

---

## 16. UI surfaces

**Top menu bar tools:** Foundations, Materials, Rooms, Objects, Staff, Utilities, Deployment, Logistics, Intelligence, Clone, Planning, Emergencies, Freefire, Shakedown, Lockdown, Bangup, Roll Call, Reports.

**Reports book tabs:** Finance, Valuation, Grants, Policy, Regime, Intake, Needs, Programs, Contraband, Emergency Services, Todo, Statistics.

**Overlays:** temperature, room quality, sector access, contraband danger, fog of war.

**Todo list:** grant checklists, warnings, and construction blockers.

---

## 17. Known pain points

These are the things worth fixing rather than replicating. They come from long-standing community consensus.

1. **Late-game performance collapse.** Per-agent A* pathfinding on a large map with 500+ entities tanks the frame rate. This is the single most common complaint.
2. **Pathfinding stupidity.** Agents queue in doorways, cluster in canteens, take absurd routes, and deadlock in sally ports.
3. **Logistics opacity.** Why a prisoner starved, why a canteen has no food, why a laundry never runs: the game rarely tells you. Debugging a broken chain is guesswork.
4. **Utilities micromanagement.** Manual cable and pipe routing is tedious at scale. The multi-power-station circuit collapse rule is unexplained and punishing.
5. **Deployment UI is coarse.** Assigning guards is fiddly, patrol route drawing is imprecise, and there is no way to express intent like "always two guards in the canteen".
6. **The needs system is invisible without a Psychologist,** and even then the report is a bar chart with no drill-down to root cause.
7. **Cell grading is under-explained.** Most players never discover the entitlement ladder.
8. **Programs are a scheduling puzzle with no feedback.** If a program never runs, the game does not say why.
9. **No undo.** A misplaced foundation costs real money and real time.
10. **Reception is a trap.** Building one is correct for contraband but throttles intake so hard that many players skip it.
11. **The tutorial is the campaign,** so sandbox players start with no idea what anything does.
12. **Contraband trading is invisible** without Intelligence research, and even then it is a table of numbers with no story.
13. **Fire and riot response is all-or-nothing.** There is no graduated escalation, so the correct play is usually to spam the biggest hammer.
14. **Save file bloat and slow saves** on large prisons.

---

## 18. What is worth keeping, unchanged

1. Declarative room requirements.
2. Room grading and the good-behaviour entitlement ladder.
3. "The room is the contraband source, not the object."
4. Escape tunnels dug at night by Clever prisoners.
5. Hidden traits derived from convictions, revealed through intelligence work.
6. The grant to-do list as a soft tutorial and goal generator.
7. Regime as an hour-block schedule per risk category.
8. Suppression as a real trade-off: control now, worse reform later.
9. Re-offending chance as the moral scoreboard running underneath the economic one.
10. Every logistics hop being a real agent walking a real path.

---

## Sources

- [Room](https://prisonarchitect.paradoxwikis.com/Rooms)
- [Room Grading](https://prisonarchitect.paradoxwikis.com/Room_Grading)
- [Prisoner](https://prisonarchitect.paradoxwikis.com/Prisoner)
- [Need](https://prisonarchitect.paradoxwikis.com/Needs)
- [Bureaucracy](https://prisonarchitect.paradoxwikis.com/Bureaucracy)
- [Programs](https://prisonarchitect.paradoxwikis.com/Programs)
- [Contraband](https://prisonarchitect.paradoxwikis.com/Contraband)
- [Regime](https://prisonarchitect.paradoxwikis.com/Regime)
- [Grants](https://prisonarchitect.paradoxwikis.com/Grants)
- [Utilities](https://prisonarchitect.paradoxwikis.com/Utilities)
- [Winning and Failure Conditions](https://prisonarchitect.paradoxwikis.com/Winning_and_Failure_Conditions)
