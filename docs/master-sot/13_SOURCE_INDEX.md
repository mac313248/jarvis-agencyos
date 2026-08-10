# 13 — SOURCE INDEX

## Strongest final evidence

The most consequential external result is the July 24, 2026 Nature Machine Intelligence controlled study: multi-agent coordination is highly task-dependent, a strong single-agent baseline is a major predictor of whether collaboration helps, and coordination can create substantial error amplification. ([Nature](https://www.nature.com/articles/s42256-026-01268-y?utm_source=chatgpt.com "Capable language models can outgrow the benefits of collaboration | Nature Machine Intelligence"))

The NeurIPS MAST research independently identified recurring multi-agent failures across system design, inter-agent alignment and verification, reinforcing deterministic orchestration and explicit verification rather than free-form agent interaction. ([NeurIPS](https://neurips.cc/virtual/2025/122442?utm_source=chatgpt.com "NeurIPS Why Do Multi-Agent LLM Systems Fail?"))

Anthropic's production experience likewise recommends simple composable patterns and documents that its successful multi-agent research system depends on explicit orchestration, delegation boundaries, context control, tooling and evaluation—not merely adding more agents. ([Anthropic Resources](https://resources.anthropic.com/building-effective-ai-agents?utm_source=chatgpt.com "Building Effective AI Agents"))

For execution infrastructure, current DBOS documentation supports the Postgres-backed durable-workflow direction, current Cursor capabilities substantially reduce what we need to custom-build for coding agents, and current MCP evolution supports treating MCP as a replaceable interoperability layer instead of AgencyOS's authority system. ([DBOS Docs](https://docs.dbos.dev/architecture?utm_source=chatgpt.com "DBOS Architecture | DBOS Docs"))

**Research is complete enough to freeze. The next phase is not Pass 19. It is creating the clean Master SOT from these locks, then implementation against the live-verification gates.**

## Additional canonical platform/research sources referenced by the frozen design

- PostgreSQL RLS: https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- PostgreSQL transactions: https://www.postgresql.org/docs/current/tutorial-transactions.html
- PostgreSQL PITR: https://www.postgresql.org/docs/current/continuous-archiving.html
- pgvector: https://github.com/pgvector/pgvector
- Hermes docs: https://hermes-agent.nousresearch.com/docs/
- Cursor Cloud Agents: https://cursor.com/docs/cloud-agent
- DBOS docs: https://docs.dbos.dev/
- OpenAI Agents SDK: https://openai.github.io/openai-agents-python/
- Anthropic Agent SDK / Managed Agents: https://platform.claude.com/docs/
- GitHub protected branches: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- MCP security considerations: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations

The full Project research history contains the detailed pass-specific source inventory. This compact index is not a replacement for those original source records.
