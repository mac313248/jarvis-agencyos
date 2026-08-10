# 09 — INTELLIGENCE & LEARNING

### OFFER INTELLIGENCE

Final design:

`EVIDENCE`
→ synthesis
→ hypothesis
→ immutable offer version
→ experiment
→ exposure/outcome
→ analysis
→ promote / revise / kill.

Jarvis may generate ideas.

It may **not** turn CRM correlations, synthetic customers, simulated interviews, or model confidence into claims that an offer works.

Causal promotion requires real-world experimental or otherwise defensible causal evidence.

Commercial launches still pass authority/spend gates.

### BEHAVIORAL INTELLIGENCE

Do not build a fictional customer “digital twin.”

V1 is:

`canonical events`
→ identity resolution
→ transparent features
→ versioned scores
→ action recommendations.

Keep separate:

**Propensity:** likely outcome.

**Uplift:** whether a particular intervention changes that outcome.

A high propensity score does not mean a message, discount, call, or offer caused or will improve the result.

Scores never grant authority.

### LEARNING

“Learning” means:

`TRACE / OUTCOME`
→ diagnose
→ propose behavior change
→ held-out evaluation
→ regression/safety/cost checks
→ governed promotion
→ shadow/canary/A-B
→ production measurement.

The production agent cannot silently edit its permanent:

- instructions;
- procedures;
- skills;
- policies;
- authority;
- model weights.

Prime Intellect remains optional for inference, evaluation, prompt optimization or later training. It is **not Jarvis's memory, brain, control plane or required V1 dependency**.

RL/fine-tuning is later and only for narrow tasks where a trustworthy reward function exists.

### MODEL ROUTING / COST CONTROL

Primary metric:

> **Cost per verified successful outcome.**

Not cheapest token.
Not cheapest first model call.
Not strongest model everywhere.

V1 routing:

`TASK + RISK + PRIVACY + TOOL NEED + PROVIDER HEALTH`
→ eligible profiles
→ select cheapest profile already proven adequate by our eval suite
→ execute
→ deterministic/eval verification
→ escalate only when needed.

Do not build a learned custom router in V1.

Native routers such as the coding runtime's own router may be used where downstream deterministic gates protect us.

Required contracts:

```
model_profile
- profile_id
- provider
- model_or_router
- version_or_alias
- capabilities
- allowed_task_types
- max_risk_class
- privacy_class
- context/tool support
- latency_class
- cost_model_ref
- eval_suite_version
- eval_results
- status
- fallback_profiles

```

```
model_route_decision
- route_id
- tenant_id
- workflow_id
- task_type
- risk_class
- eligible_profiles
- selected_profile
- reason_codes
- budget_before
- provider_health_ref
- fallback_plan
- eval_policy_version

```
