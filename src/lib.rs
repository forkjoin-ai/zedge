mod context_server;
mod provider;
mod slash_commands;

use zed_extension_api::{self as zed, *};

struct ZedgeExtension;

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
            "zedge-pool" => slash_commands::run_pool(),
            "zedge-logs" => slash_commands::run_logs(),
            "zedge-clear" => slash_commands::run_clear(),
            "zedge-restart" => slash_commands::run_restart(),
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
            "zedge-feedback" => slash_commands::run_feedback(),
            _ => Err(format!("Unknown command: {}", command.name)),
        }
    }

    fn complete_slash_command_argument(
        &self,
        command: SlashCommand,
        _args: Vec<String>,
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
            _ => Ok(Vec::new()),
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        _worktree: &Worktree,
    ) -> Result<Command> {
        if language_server_id.as_ref() == "gnosis-lsp" {
            Ok(Command {
                command: "bun".to_string(),
                args: vec!["open-source/zedge/companion/src/gnosis-lsp.ts".to_string()],
                env: Vec::new(),
            })
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
            Ok(Command {
                command: "bun".to_string(),
                args: vec!["open-source/zedge/companion/src/mcp-stdio.ts".to_string()],
                env: Vec::new(),
            })
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
                installation_instructions: "Install Bun (https://bun.sh) and start the companion sidecar:\n\n```\nbun open-source/zedge/companion/src/index.ts\n```\n\nThe sidecar runs on localhost:7331. The MCP context server bridge connects to it automatically.".to_string(),
                settings_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "port": { "type": "number", "default": 7331 },
                        "preferredModel": { "type": "string", "default": "tinyllama-1.1b" },
                        "cloudRunDirect": { "type": "boolean", "default": true }
                    }
                }).to_string(),
                default_settings: serde_json::json!({
                    "port": 7331,
                    "preferredModel": "tinyllama-1.1b",
                    "cloudRunDirect": true
                }).to_string(),
            }))
        } else {
            Ok(None)
        }
    }
}

zed::register_extension!(ZedgeExtension);
