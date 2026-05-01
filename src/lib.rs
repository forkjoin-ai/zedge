mod context_server;
mod provider;
mod slash_commands;

use zed_extension_api::{
    self as zed,
    http_client::{HttpMethod, HttpRequest, RedirectPolicy},
    *,
};

struct EdgeAiExtension;
const TS_ENTRY_LAUNCHER: &str = "open-source/zedge/scripts/run-ts-entry.sh";
/// Ensures companion /health before MCP stdio (starts supervisor if needed).
const RUN_MCP_WITH_SUPERVISOR: &str = "open-source/zedge/scripts/run-mcp-with-supervisor.sh";

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

fn babelfish_language_completions(operation: &str) -> Vec<SlashCommandArgumentCompletion> {
    fetch_babelfish_capabilities()
        .and_then(|value| value["languages"].as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter(|language| {
            language["operations"][operation]
                .as_str()
                .unwrap_or("unsupported")
                != "unsupported"
        })
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

impl zed::Extension for EdgeAiExtension {
    fn new() -> Self {
        EdgeAiExtension
    }

    fn run_slash_command(
        &self,
        command: SlashCommand,
        _args: Vec<String>,
        worktree: Option<&Worktree>,
    ) -> Result<SlashCommandOutput, String> {
        match command.name.as_str() {
            "edge-setup" => slash_commands::run_setup(),
            "edge-status" => slash_commands::run_status(worktree),
            "edge-models" => slash_commands::run_models(),
            "edge-pool" => slash_commands::run_pool(&_args),
            "edge-logs" => slash_commands::run_logs(),
            "edge-clear" => slash_commands::run_clear(),
            "edge-restart" => slash_commands::run_restart(),
            "edge-selftest" => slash_commands::run_selftest(&_args),
            "edge-tts" => slash_commands::run_tts(&_args),
            "edgework" => slash_commands::run_edgework(&_args),
            "edge-admin" => slash_commands::run_admin(&_args),
            "edge-mesh" => slash_commands::run_mesh(&_args),
            "edge-crdt" => slash_commands::run_crdt(&_args),
            "edge-forge" => slash_commands::run_forge(&_args),
            "edge-kernel" => slash_commands::run_kernel(&_args),
            "edge-scaffold" => slash_commands::run_scaffold(&_args),
            "edge-gnot" => slash_commands::run_gnot(&_args),
            "edge-gnosis" => slash_commands::run_gnosis(&_args),
            "edge-gnosis-run" => slash_commands::run_gnosis_run(worktree),
            "edge-gnosis-viz" => slash_commands::run_gnosis_viz(worktree),
            "edge-test" => slash_commands::run_test(worktree),
            "edge-feedback" => slash_commands::run_feedback(&_args),
            "edge-babelfish" => slash_commands::run_babelfish(&_args, worktree),
            "edge-babelfish-native" => slash_commands::run_babelfish_native(&_args, worktree),
            "edge-review" => slash_commands::run_review(worktree),
            "edge-void" => slash_commands::run_void(&_args),
            "edge-swarm" => slash_commands::run_swarm(&_args),
            "edge-engram" => slash_commands::run_engram(&_args),
            "edge-emotion" => slash_commands::run_emotion(&_args, worktree),
            "edge-agent" => slash_commands::run_agent(&_args),
            _ => Err(format!("Unknown command: {}", command.name)),
        }
    }

    fn complete_slash_command_argument(
        &self,
        command: SlashCommand,
        args: Vec<String>,
    ) -> Result<Vec<SlashCommandArgumentCompletion>, String> {
        match command.name.as_str() {
            "edge-setup" => Ok(Vec::new()),
            "edge-models" => Ok(provider::visible_models()
                .iter()
                .map(|m| SlashCommandArgumentCompletion {
                    label: m.display_name.to_string(),
                    new_text: m.id.to_string(),
                    run_command: true,
                })
                .collect()),
            "edgework" => {
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
                Ok(commands
                    .into_iter()
                    .map(|(cmd, desc)| SlashCommandArgumentCompletion {
                        label: format!("{cmd} — {desc}"),
                        new_text: cmd.to_string(),
                        run_command: true,
                    })
                    .collect())
            }
            "edge-admin" => {
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
                Ok(commands
                    .into_iter()
                    .map(|(cmd, desc)| SlashCommandArgumentCompletion {
                        label: format!("{cmd} — {desc}"),
                        new_text: cmd.to_string(),
                        run_command: true,
                    })
                    .collect())
            }
            "edge-tts" => Ok(vec![
                SlashCommandArgumentCompletion {
                    label: "status — Show TTS relay status".into(),
                    new_text: "status".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "enable — Enable host playback relay".into(),
                    new_text: "enable".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "disable — Disable host playback relay".into(),
                    new_text: "disable".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "host — Play through the host companion".into(),
                    new_text: "host".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "file — Write WAV files only".into(),
                    new_text: "file".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "pulse — Play through PulseAudio TCP".into(),
                    new_text: "pulse".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "alsa — Play through Linux /dev/snd".into(),
                    new_text: "alsa".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "auto — Resolve platform default".into(),
                    new_text: "auto".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "speak — Speak text through Moonshine TTS".into(),
                    new_text: "speak ".into(),
                    run_command: false,
                },
            ]),
            "edge-mesh" => Ok(vec![
                SlashCommandArgumentCompletion {
                    label: "status — Show mesh status".into(),
                    new_text: "status".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "start — Start P2P mesh".into(),
                    new_text: "start".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "stop — Stop P2P mesh".into(),
                    new_text: "stop".into(),
                    run_command: true,
                },
            ]),
            "edge-pool" => Ok(vec![
                SlashCommandArgumentCompletion {
                    label: "status — Show compute pool status".into(),
                    new_text: "status".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "join — Join the compute pool".into(),
                    new_text: "join".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "leave — Leave the compute pool".into(),
                    new_text: "leave".into(),
                    run_command: true,
                },
            ]),
            "edge-crdt" => Ok(vec![
                SlashCommandArgumentCompletion {
                    label: "status — CRDT overview".into(),
                    new_text: "status".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "files — Open CRDT files".into(),
                    new_text: "files".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "cursors — Active cursors".into(),
                    new_text: "cursors".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "participants — Connected participants".into(),
                    new_text: "participants".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "ledger — Contribution ledger".into(),
                    new_text: "ledger".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "diagnostics — CRDT diagnostics".into(),
                    new_text: "diagnostics".into(),
                    run_command: true,
                },
            ]),
            "edge-forge" => Ok(vec![
                SlashCommandArgumentCompletion {
                    label: "status — ForgeCD status".into(),
                    new_text: "status".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "projects — List projects".into(),
                    new_text: "projects".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "deploy — Deploy a project".into(),
                    new_text: "deploy ".into(),
                    run_command: false,
                },
            ]),
            "edge-scaffold" => Ok(vec![
                SlashCommandArgumentCompletion {
                    label: "site — Aeon Foundation site (SSR, routing, tokens)".into(),
                    new_text: "site ".into(),
                    run_command: false,
                },
                SlashCommandArgumentCompletion {
                    label: "app — Full-stack Aeon app (site + API + auth)".into(),
                    new_text: "app ".into(),
                    run_command: false,
                },
                SlashCommandArgumentCompletion {
                    label: "worker — Edge worker (CF Workers / Bun)".into(),
                    new_text: "worker ".into(),
                    run_command: false,
                },
                SlashCommandArgumentCompletion {
                    label: "mcp — MCP server (Model Context Protocol)".into(),
                    new_text: "mcp ".into(),
                    run_command: false,
                },
                SlashCommandArgumentCompletion {
                    label: "agent — AI agent template (tool use + memory)".into(),
                    new_text: "agent ".into(),
                    run_command: false,
                },
                SlashCommandArgumentCompletion {
                    label: "extension — Zed editor extension".into(),
                    new_text: "extension ".into(),
                    run_command: false,
                },
                SlashCommandArgumentCompletion {
                    label: "gnosis — Gnosis topological graph project".into(),
                    new_text: "gnosis ".into(),
                    run_command: false,
                },
            ]),
            "edge-gnot" => Ok(vec![
                SlashCommandArgumentCompletion {
                    label: "files — List workspace .gnot files".into(),
                    new_text: "files".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "lint — Lint a .gnot file".into(),
                    new_text: "lint ".into(),
                    run_command: false,
                },
                SlashCommandArgumentCompletion {
                    label: "format — Format a .gnot file".into(),
                    new_text: "format ".into(),
                    run_command: false,
                },
                SlashCommandArgumentCompletion {
                    label: "doctor — Inspect deploy readiness for a gnot app".into(),
                    new_text: "doctor ".into(),
                    run_command: false,
                },
                SlashCommandArgumentCompletion {
                    label: "next — Suggest the next gnot deploy-shell action".into(),
                    new_text: "next ".into(),
                    run_command: false,
                },
                SlashCommandArgumentCompletion {
                    label: "status — Show release status for a gnot app".into(),
                    new_text: "status ".into(),
                    run_command: false,
                },
            ]),
            "edge-kernel" => Ok(vec![
                SlashCommandArgumentCompletion {
                    label: "status — Daemons and plugins".into(),
                    new_text: "status".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "daemons — Running daemons".into(),
                    new_text: "daemons".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "plugins — Loaded plugins".into(),
                    new_text: "plugins".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "commands — Available commands".into(),
                    new_text: "commands".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "flight-log — Event flight log".into(),
                    new_text: "flight-log".into(),
                    run_command: true,
                },
            ]),
            "edge-babelfish" => {
                if args.is_empty() {
                    Ok(vec![
                        SlashCommandArgumentCompletion {
                            label: "capabilities — Show supported programming and human languages"
                                .into(),
                            new_text: "capabilities".into(),
                            run_command: true,
                        },
                        SlashCommandArgumentCompletion {
                            label: "fastest — Preview fastest Gnarly topology candidates".into(),
                            new_text: "fastest ".into(),
                            run_command: false,
                        },
                        SlashCommandArgumentCompletion {
                            label: "compile-gnarly — Compile a .gnarly file to GG and manifests"
                                .into(),
                            new_text: "compile-gnarly ".into(),
                            run_command: false,
                        },
                        SlashCommandArgumentCompletion {
                            label: "gnarly-from — Create a .gnarly draft from a source file".into(),
                            new_text: "gnarly-from ".into(),
                            run_command: false,
                        },
                        SlashCommandArgumentCompletion {
                            label: "explain — Explain a file via Babelfish".into(),
                            new_text: "explain ".into(),
                            run_command: false,
                        },
                        SlashCommandArgumentCompletion {
                            label: "translate-code — Preview source-to-source translation".into(),
                            new_text: "translate-code ".into(),
                            run_command: false,
                        },
                        SlashCommandArgumentCompletion {
                            label: "translate-text — Translate comments, docs, and diagnostics"
                                .into(),
                            new_text: "translate-text ".into(),
                            run_command: false,
                        },
                        SlashCommandArgumentCompletion {
                            label: "generate — Write generated target-language files".into(),
                            new_text: "generate ".into(),
                            run_command: false,
                        },
                        SlashCommandArgumentCompletion {
                            label: "rewrite-preview — Preview an in-place rewrite".into(),
                            new_text: "rewrite-preview ".into(),
                            run_command: false,
                        },
                        SlashCommandArgumentCompletion {
                            label: "apply — Apply a stored preview token".into(),
                            new_text: "apply ".into(),
                            run_command: false,
                        },
                    ])
                } else {
                    match args[0].as_str() {
                        "translate-code" | "generate" => {
                            Ok(babelfish_language_completions("translate"))
                        }
                        "rewrite-preview" => Ok(babelfish_language_completions("rewritePreview")),
                        "translate-text" => Ok(babelfish_human_language_completions()),
                        _ => Ok(Vec::new()),
                    }
                }
            }
            "edge-babelfish-native" => {
                if args.is_empty() {
                    Ok(vec![SlashCommandArgumentCompletion {
                        label: "translate-code — Run native WASM 0-latency translation".into(),
                        new_text: "translate-code ".into(),
                        run_command: false,
                    }])
                } else {
                    Ok(babelfish_language_completions("translate"))
                }
            }
            "edge-feedback" => Ok(vec![
                SlashCommandArgumentCompletion {
                    label: "1 — Poor response".into(),
                    new_text: "1 ".into(),
                    run_command: false,
                },
                SlashCommandArgumentCompletion {
                    label: "2 — Weak response".into(),
                    new_text: "2 ".into(),
                    run_command: false,
                },
                SlashCommandArgumentCompletion {
                    label: "3 — Mixed response".into(),
                    new_text: "3 ".into(),
                    run_command: false,
                },
                SlashCommandArgumentCompletion {
                    label: "4 — Good response".into(),
                    new_text: "4 ".into(),
                    run_command: false,
                },
                SlashCommandArgumentCompletion {
                    label: "5 — Excellent response".into(),
                    new_text: "5 ".into(),
                    run_command: false,
                },
            ]),
            "edge-void" => Ok(vec![
                SlashCommandArgumentCompletion {
                    label: "status — Show void-map status".into(),
                    new_text: "status".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "query — Query entries by file/category".into(),
                    new_text: "query ".into(),
                    run_command: false,
                },
                SlashCommandArgumentCompletion {
                    label: "steering — Show steering vector".into(),
                    new_text: "steering ".into(),
                    run_command: false,
                },
                SlashCommandArgumentCompletion {
                    label: "export — Export training records".into(),
                    new_text: "export ".into(),
                    run_command: false,
                },
                SlashCommandArgumentCompletion {
                    label: "compact — Compact old entries".into(),
                    new_text: "compact".into(),
                    run_command: true,
                },
            ]),
            "edge-swarm" => Ok(vec![
                SlashCommandArgumentCompletion {
                    label: "roles — Show available swarm roles".into(),
                    new_text: "".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "review the current diff — Start a review/refactor/test swarm".into(),
                    new_text: "review the current diff".into(),
                    run_command: true,
                },
            ]),
            "edge-engram" => Ok(vec![
                SlashCommandArgumentCompletion {
                    label: "status — Show engram-store status".into(),
                    new_text: "status".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "recall — Recall matching memory".into(),
                    new_text: "recall ".into(),
                    run_command: false,
                },
                SlashCommandArgumentCompletion {
                    label: "remember — Store a memory".into(),
                    new_text: "remember ".into(),
                    run_command: false,
                },
                SlashCommandArgumentCompletion {
                    label: "forget — Remove an engram by id".into(),
                    new_text: "forget ".into(),
                    run_command: false,
                },
            ]),
            "edge-emotion" => Ok(vec![SlashCommandArgumentCompletion {
                label: "Analyze a file path".into(),
                new_text: "".into(),
                run_command: false,
            }]),
            "edge-agent" => Ok(vec![
                SlashCommandArgumentCompletion {
                    label: "list — List GG agents".into(),
                    new_text: "list".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "trigger — Trigger an agent".into(),
                    new_text: "trigger ".into(),
                    run_command: false,
                },
                SlashCommandArgumentCompletion {
                    label: "status — Show Forge agent status".into(),
                    new_text: "status".into(),
                    run_command: true,
                },
                SlashCommandArgumentCompletion {
                    label: "health — Show health for one agent".into(),
                    new_text: "health ".into(),
                    run_command: false,
                },
            ]),
            _ => Ok(Vec::new()),
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        _worktree: &Worktree,
    ) -> Result<Command> {
        if language_server_id.as_ref() == "gnosis-lsp" {
            Ok(ts_entry_command(
                "open-source/zedge/companion/src/gnosis-lsp.ts",
            ))
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
                command: "/bin/sh".to_string(),
                args: vec![RUN_MCP_WITH_SUPERVISOR.to_string()],
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
                installation_instructions: "First-time users: type **/edge-setup** in Zed for the one-command install (macOS). Or from the repo root: `pnpm run zedge:launch-agent:install` so port 7331 stays up after reboot.\n\nThis context server runs `run-mcp-with-supervisor.sh` (starts the sidecar if health fails, then MCP). Zed Agent still uses OpenAI-compatible HTTP to 7331 directly — the launch agent covers both.\n".to_string(),
                settings_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "port": { "type": "number", "default": 7331 },
                        "preferredModel": { "type": "string", "default": "gnosis-local" },
                        "cloudRunDirect": { "type": "boolean", "default": false },
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
                    "preferredModel": "gnosis-local",
                    "cloudRunDirect": false,
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

zed::register_extension!(EdgeAiExtension);
