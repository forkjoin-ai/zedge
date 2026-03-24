mod context_server;
mod provider;
mod slash_commands;

use zed_extension_api::{
    self as zed,
    http_client::{HttpMethod, HttpRequest, RedirectPolicy},
    *,
};

struct ZedgeExtension;
const TS_ENTRY_LAUNCHER: &str = "open-source/zedge/scripts/run-ts-entry.sh";

fn ts_entry_command(entry: &str) -> Command {
    Command {
        command: "/bin/sh".to_string(),
        args: vec![TS_ENTRY_LAUNCHER.to_string(), entry.to_string()],
        env: Vec::new(),
    }
}

fn fetch_babelfish_capabilities() -> Option<serde_json::Value> {
    let url = format!("{}/babelfish/capabilities", provider::COMPANION_URL);
    let response = HttpRequest::builder()
        .method(HttpMethod::Get)
        .url(&url)
        .redirect_policy(RedirectPolicy::FollowAll)
        .build()
        .ok()?
        .fetch()
        .ok()?;
    serde_json::from_slice::<serde_json::Value>(&response.body).ok()
}

fn babelfish_language_completions(
    operation: &str,
) -> Vec<SlashCommandArgumentCompletion> {
    fetch_babelfish_capabilities()
        .and_then(|value| value["languages"].as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter(|language| language["operations"][operation].as_str().unwrap_or("unsupported") != "unsupported")
        .map(|language| {
            let id = language["id"].as_str().unwrap_or("?");
            let display_name = language["displayName"].as_str().unwrap_or(id);
            SlashCommandArgumentCompletion {
                label: format!("{id} — {display_name}"),
                new_text: id.to_string(),
                run_command: false,
            }
        })
        .collect()
}

fn babelfish_human_language_completions() -> Vec<SlashCommandArgumentCompletion> {
    fetch_babelfish_capabilities()
        .and_then(|value| value["humanLanguages"].as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .map(|language| {
            let code = language["code"].as_str().unwrap_or("?");
            let name = language["name"].as_str().unwrap_or(code);
            SlashCommandArgumentCompletion {
                label: format!("{code} — {name}"),
                new_text: code.to_string(),
                run_command: false,
            }
        })
        .collect()
}

impl zed::Extension for ZedgeExtension {
    fn new() -> Self {
        ZedgeExtension
    }

    fn run_slash_command(
        &self,
        command: SlashCommand,
        _args: Vec<String>,
        worktree: Option<&Worktree>,
    ) -> Result<SlashCommandOutput, String> {
        match command.name.as_str() {
            "zedge-status" => slash_commands::run_status(worktree),
            "zedge-models" => slash_commands::run_models(),
            "zedge-pool" => slash_commands::run_pool(&_args),
            "zedge-logs" => slash_commands::run_logs(),
            "zedge-clear" => slash_commands::run_clear(),
            "zedge-restart" => slash_commands::run_restart(),
            "zedge-selftest" => slash_commands::run_selftest(&_args),
            "zedgework" => slash_commands::run_edgework(&_args),
            "zedge-admin" => slash_commands::run_admin(&_args),
            "zedge-mesh" => slash_commands::run_mesh(&_args),
            "zedge-crdt" => slash_commands::run_crdt(&_args),
            "zedge-forge" => slash_commands::run_forge(&_args),
            "zedge-kernel" => slash_commands::run_kernel(&_args),
            "zedge-scaffold" => slash_commands::run_scaffold(&_args),
            "zedge-gnosis" => slash_commands::run_gnosis(&_args),
            "zedge-gnosis-run" => slash_commands::run_gnosis_run(worktree),
            "zedge-gnosis-viz" => slash_commands::run_gnosis_viz(worktree),
            "zedge-test" => slash_commands::run_test(worktree),
            "zedge-feedback" => slash_commands::run_feedback(&_args),
            "zedge-babelfish" => slash_commands::run_babelfish(&_args, worktree),
            "zedge-review" => slash_commands::run_review(worktree),
            _ => Err(format!("Unknown command: {}", command.name)),
        }
    }

    fn complete_slash_command_argument(
        &self,
        command: SlashCommand,
        args: Vec<String>,
    ) -> Result<Vec<SlashCommandArgumentCompletion>, String> {
        match command.name.as_str() {
            "zedge-models" => Ok(provider::MODELS
                .iter()
                .map(|m| SlashCommandArgumentCompletion {
                    label: m.display_name.to_string(),
                    new_text: m.id.to_string(),
                    run_command: true,
                })
                .collect()),
            "zedgework" => {
                let commands = vec![
                    ("emotions", "Analyze emotions in text"),
                    ("sentiment", "Analyze sentiment"),
                    ("entities", "Extract entities"),
                    ("embed", "Generate embeddings"),
                    ("language", "Detect language"),
                    ("summarize", "Summarize text"),
                    ("health", "Check API health"),
                    ("status", "Auth and API status"),
                    ("whoami", "Show current identity"),
                    ("dashboard", "Account overview"),
                    ("usage", "Usage stats"),
                    ("limits", "Rate limits"),
                    ("pricing", "View pricing"),
                    ("keys list", "List API keys"),
                    ("workflows --list", "List AI workflows"),
                    ("test", "Test integration"),
                ];
                Ok(commands.into_iter().map(|(cmd, desc)| SlashCommandArgumentCompletion {
                    label: format!("{cmd} — {desc}"),
                    new_text: cmd.to_string(),
                    run_command: true,
                }).collect())
            }
            "zedge-admin" => {
                let commands = vec![
                    ("doctor", "Runtime and MCP health diagnostics"),
                    ("ops status", "Operator health snapshot"),
                    ("ops logs", "Monitor and log scripts"),
                    ("ops costs", "Cost and spend summary"),
                    ("ops services", "Service inventory"),
                    ("ops cloudrun status", "Cloud Run status"),
                    ("ops cloudrun logs", "Cloud Run logs"),
                    ("ops edge health", "Edge health check"),
                    ("fleet status", "Fleet status snapshot"),
                    ("fleet health", "Fleet health checks"),
                    ("fleet sessions", "Fleet session capacity"),
                    ("fleet logs", "Tail fleet logs"),
                    ("mcp list", "MCP catalog entries"),
                    ("mcp doctor", "MCP catalog health"),
                    ("ai diagnose", "AI diagnostics"),
                    ("ai runbook", "Curated runbook sequences"),
                    ("workflow list", "Available workflows"),
                ];
                Ok(commands.into_iter().map(|(cmd, desc)| SlashCommandArgumentCompletion {
                    label: format!("{cmd} — {desc}"),
                    new_text: cmd.to_string(),
                    run_command: true,
                }).collect())
            }
            "zedge-mesh" => {
                Ok(vec![
                    SlashCommandArgumentCompletion { label: "status — Show mesh status".into(), new_text: "status".into(), run_command: true },
                    SlashCommandArgumentCompletion { label: "start — Start P2P mesh".into(), new_text: "start".into(), run_command: true },
                    SlashCommandArgumentCompletion { label: "stop — Stop P2P mesh".into(), new_text: "stop".into(), run_command: true },
                ])
            }
            "zedge-pool" => {
                Ok(vec![
                    SlashCommandArgumentCompletion { label: "status — Show compute pool status".into(), new_text: "status".into(), run_command: true },
                    SlashCommandArgumentCompletion { label: "join — Join the compute pool".into(), new_text: "join".into(), run_command: true },
                    SlashCommandArgumentCompletion { label: "leave — Leave the compute pool".into(), new_text: "leave".into(), run_command: true },
                ])
            }
            "zedge-crdt" => {
                Ok(vec![
                    SlashCommandArgumentCompletion { label: "status — CRDT overview".into(), new_text: "status".into(), run_command: true },
                    SlashCommandArgumentCompletion { label: "files — Open CRDT files".into(), new_text: "files".into(), run_command: true },
                    SlashCommandArgumentCompletion { label: "cursors — Active cursors".into(), new_text: "cursors".into(), run_command: true },
                    SlashCommandArgumentCompletion { label: "participants — Connected participants".into(), new_text: "participants".into(), run_command: true },
                    SlashCommandArgumentCompletion { label: "ledger — Contribution ledger".into(), new_text: "ledger".into(), run_command: true },
                    SlashCommandArgumentCompletion { label: "diagnostics — CRDT diagnostics".into(), new_text: "diagnostics".into(), run_command: true },
                ])
            }
            "zedge-forge" => {
                Ok(vec![
                    SlashCommandArgumentCompletion { label: "status — ForgeCD status".into(), new_text: "status".into(), run_command: true },
                    SlashCommandArgumentCompletion { label: "projects — List projects".into(), new_text: "projects".into(), run_command: true },
                    SlashCommandArgumentCompletion { label: "deploy — Deploy a project".into(), new_text: "deploy ".into(), run_command: false },
                ])
            }
            "zedge-scaffold" => {
                Ok(vec![
                    SlashCommandArgumentCompletion { label: "site — Aeon Foundation site (SSR, routing, tokens)".into(), new_text: "site ".into(), run_command: false },
                    SlashCommandArgumentCompletion { label: "app — Full-stack Aeon app (site + API + auth)".into(), new_text: "app ".into(), run_command: false },
                    SlashCommandArgumentCompletion { label: "worker — Edge worker (CF Workers / Bun)".into(), new_text: "worker ".into(), run_command: false },
                    SlashCommandArgumentCompletion { label: "mcp — MCP server (Model Context Protocol)".into(), new_text: "mcp ".into(), run_command: false },
                    SlashCommandArgumentCompletion { label: "agent — AI agent template (tool use + memory)".into(), new_text: "agent ".into(), run_command: false },
                    SlashCommandArgumentCompletion { label: "extension — Zed editor extension".into(), new_text: "extension ".into(), run_command: false },
                    SlashCommandArgumentCompletion { label: "gnosis — Gnosis topological graph project".into(), new_text: "gnosis ".into(), run_command: false },
                ])
            }
            "zedge-kernel" => {
                Ok(vec![
                    SlashCommandArgumentCompletion { label: "status — Daemons and plugins".into(), new_text: "status".into(), run_command: true },
                    SlashCommandArgumentCompletion { label: "daemons — Running daemons".into(), new_text: "daemons".into(), run_command: true },
                    SlashCommandArgumentCompletion { label: "plugins — Loaded plugins".into(), new_text: "plugins".into(), run_command: true },
                    SlashCommandArgumentCompletion { label: "commands — Available commands".into(), new_text: "commands".into(), run_command: true },
                    SlashCommandArgumentCompletion { label: "flight-log — Event flight log".into(), new_text: "flight-log".into(), run_command: true },
                ])
            }
            "zedge-babelfish" => {
                if args.is_empty() {
                    Ok(vec![
                        SlashCommandArgumentCompletion { label: "capabilities — Show supported programming and human languages".into(), new_text: "capabilities".into(), run_command: true },
                        SlashCommandArgumentCompletion { label: "explain — Explain a file via Babelfish".into(), new_text: "explain ".into(), run_command: false },
                        SlashCommandArgumentCompletion { label: "translate-code — Preview source-to-source translation".into(), new_text: "translate-code ".into(), run_command: false },
                        SlashCommandArgumentCompletion { label: "translate-text — Translate comments, docs, and diagnostics".into(), new_text: "translate-text ".into(), run_command: false },
                        SlashCommandArgumentCompletion { label: "generate — Write generated target-language files".into(), new_text: "generate ".into(), run_command: false },
                        SlashCommandArgumentCompletion { label: "rewrite-preview — Preview an in-place rewrite".into(), new_text: "rewrite-preview ".into(), run_command: false },
                        SlashCommandArgumentCompletion { label: "apply — Apply a stored preview token".into(), new_text: "apply ".into(), run_command: false },
                    ])
                } else {
                    match args[0].as_str() {
                        "translate-code" | "generate" => Ok(babelfish_language_completions("translate")),
                        "rewrite-preview" => Ok(babelfish_language_completions("rewritePreview")),
                        "translate-text" => Ok(babelfish_human_language_completions()),
                        _ => Ok(Vec::new()),
                    }
                }
            }
            "zedge-feedback" => {
                Ok(vec![
                    SlashCommandArgumentCompletion { label: "1 — Poor response".into(), new_text: "1 ".into(), run_command: false },
                    SlashCommandArgumentCompletion { label: "2 — Weak response".into(), new_text: "2 ".into(), run_command: false },
                    SlashCommandArgumentCompletion { label: "3 — Mixed response".into(), new_text: "3 ".into(), run_command: false },
                    SlashCommandArgumentCompletion { label: "4 — Good response".into(), new_text: "4 ".into(), run_command: false },
                    SlashCommandArgumentCompletion { label: "5 — Excellent response".into(), new_text: "5 ".into(), run_command: false },
                ])
            }
            _ => Ok(Vec::new()),
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        _worktree: &Worktree,
    ) -> Result<Command> {
        if language_server_id.as_ref() == "gnosis-lsp" {
            Ok(ts_entry_command("open-source/zedge/companion/src/gnosis-lsp.ts"))
        } else {
            Err(format!("Unknown language server: {language_server_id}"))
        }
    }

    fn context_server_command(
        &mut self,
        context_server_id: &ContextServerId,
        _project: &Project,
    ) -> Result<Command> {
        if context_server_id.as_ref() == "zedge-companion" {
            Ok(ts_entry_command("open-source/zedge/companion/src/mcp-stdio.ts"))
        } else {
            Err(format!("Unknown context server: {context_server_id}"))
        }
    }

    fn context_server_configuration(
        &mut self,
        context_server_id: &ContextServerId,
        _project: &Project,
    ) -> Result<Option<ContextServerConfiguration>> {
        if context_server_id.as_ref() == "zedge-companion" {
            Ok(Some(ContextServerConfiguration {
                installation_instructions: "The companion sidecar starts automatically through the checked-in Bun launcher when the context server launches.\n\nTo start manually with the same guarded restart policy:\n\n```\nbun run open-source/zedge/companion/src/companion-supervisor.ts\n```\n\nThe sidecar runs on localhost:7331. The MCP context server bridge and the manual supervisor both poll health and restart their owned child when needed.".to_string(),
                settings_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "port": { "type": "number", "default": 7331 },
                        "preferredModel": { "type": "string", "default": "wasm-local" },
                        "cloudRunDirect": { "type": "boolean", "default": true },
                        "babelfish": {
                            "type": "object",
                            "properties": {
                                "enabled": { "type": "boolean", "default": true },
                                "ambientSuggestions": { "type": "boolean", "default": true },
                                "defaultHumanLanguage": { "type": "string", "default": "en" },
                                "requirePreviewForInPlaceRewrite": { "type": "boolean", "default": true }
                            }
                        }
                    }
                }).to_string(),
                default_settings: serde_json::json!({
                    "port": 7331,
                    "preferredModel": "wasm-local",
                    "cloudRunDirect": true,
                    "babelfish": {
                        "enabled": true,
                        "ambientSuggestions": true,
                        "defaultHumanLanguage": "en",
                        "requirePreviewForInPlaceRewrite": true
                    }
                }).to_string(),
            }))
        } else {
            Ok(None)
        }
    }
}

zed::register_extension!(ZedgeExtension);
