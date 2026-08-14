---
name: parallel-setup
description: Set up the Parallel plugin (install pinned parallel-cli and authenticate). Use when the user types /parallel-setup or Parallel web tools are unavailable.
---

# Parallel Plugin Setup

Repo-native setup for Cloud Agents. Desktop marketplace `/parallel-setup` is not durable on fresh VMs; this skill + `.cursor/commands/parallel-setup.md` are the checkout-backed path.

## Authority

Jarvis remains the authority plane. Parallel is a web-research tool. It may not set PASS/DONE, merge eligibility, or new product scope. Never place `PARALLEL_API_KEY` in source, git, prompts, evidence, or logs.

## Step 1: Check if CLI is installed

```bash
export PATH="$HOME/.local/bin:$PATH"
parallel-cli --version
```

If this prints a version, skip to **Step 2: Authenticate**.

## Step 1b: Install (pinned — no curl|bash)

This repository forbids unpinned `curl | bash` installers. Use the pinned PyPI package:

```bash
pip3 install --user 'parallel-web-tools[cli]==0.9.2'
export PATH="$HOME/.local/bin:$PATH"
parallel-cli --version
```

Cloud environment install (`.cursor/environment.json`) already runs this pin so new VMs get the CLI from the Build snapshot when possible.

### If installation fails

Tell the user installation needs network + user site-packages write access. Do not fall back to `curl -fsSL https://parallel.ai/install.sh | bash` in this repo.

## Step 2: Authenticate

Check auth status (never print secret values):

```bash
parallel-cli auth
```

Preferred for Cloud Agents: set secret `PARALLEL_API_KEY` in the Cursor Cloud dashboard (not in git). The CLI reads that env var.

Interactive `parallel-cli login` (device OAuth) is WAITING_ON_OWNER — browser/OAuth is owner access work.

## Step 3: Verify

```bash
export PATH="$HOME/.local/bin:$PATH"
parallel-cli --version
parallel-cli auth
```

Confirm: CLI installed, authenticated (env key or stored login), ready for `parallel-web-search` / extract / research / enrich skills.

If `PARALLEL_API_KEY` is missing, stop and report WAITING_ON_OWNER to add the Cloud dashboard secret.
