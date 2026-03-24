/// Zedge Slash Commands (v0.7 API)
///
/// Uses HttpRequest builder, SlashCommandOutput with labeled sections,
/// and Worktree for workspace-aware context.
use zed_extension_api::{
    self as zed, http_client::*, SlashCommandOutput, SlashCommandOutputSection, Worktree,
};

use crate::provider;

/// Helper: GET from companion and return body as string
fn companion_get(path: &str) -> Result<String, String> {
    let url = format!("{}{}", provider::COMPANION_URL, path);
    let response = HttpRequest::builder()
        .method(HttpMethod::Get)
        .url(&url)
        .redirect_policy(RedirectPolicy::FollowAll)
        .build()?
        .fetch()
        .map_err(|e| format!("Companion unavailable: {e}"))?;
    String::from_utf8(response.body).map_err(|e| format!("Invalid UTF-8: {e}"))
}

/// Helper: POST to companion and return body as string
fn companion_post(path: &str) -> Result<String, String> {
    let url = format!("{}{}", provider::COMPANION_URL, path);
    let response = HttpRequest::builder()
        .method(HttpMethod::Post)
        .url(&url)
        .redirect_policy(RedirectPolicy::FollowAll)
        .build()?
        .fetch()
        .map_err(|e| format!("Companion unavailable: {e}"))?;
    String::from_utf8(response.body).map_err(|e| format!("Invalid UTF-8: {e}"))
}

/// Helper: POST JSON to companion and return body as string
fn companion_post_json(path: &str, body: serde_json::Value) -> Result<String, String> {
    let url = format!("{}{}", provider::COMPANION_URL, path);
    let response = HttpRequest::builder()
        .method(HttpMethod::Post)
        .url(&url)
        .header("Content-Type", "application/json")
        .body(body.to_string().into_bytes())
        .redirect_policy(RedirectPolicy::FollowAll)
        .build()?
        .fetch()
        .map_err(|e| format!("Companion unavailable: {e}"))?;
    String::from_utf8(response.body).map_err(|e| format!("Invalid UTF-8: {e}"))
}

/// Helper: DELETE to companion and return body as string
fn companion_delete(path: &str) -> Result<String, String> {
    let url = format!("{}{}", provider::COMPANION_URL, path);
    let response = HttpRequest::builder()
        .method(HttpMethod::Delete)
        .url(&url)
        .redirect_policy(RedirectPolicy::FollowAll)
        .build()?
        .fetch()
        .map_err(|e| format!("Companion unavailable: {e}"))?;
    String::from_utf8(response.body).map_err(|e| format!("Invalid UTF-8: {e}"))
}

fn escape_query_component(value: &str) -> String {
    value
        .replace('%', "%25")
        .replace(' ', "%20")
        .replace('#', "%23")
        .replace('&', "%26")
        .replace('?', "%3F")
        .replace('+', "%2B")
}

/// Build a SlashCommandOutput with a single labeled section spanning the full text
fn output_with_section(text: String, label: &str) -> SlashCommandOutput {
    let len = text.len() as u32;
    SlashCommandOutput {
        text,
        sections: vec![SlashCommandOutputSection {
            range: zed::Range { start: 0, end: len },
            label: label.to_string(),
        }],
    }
}

/// /zedge-status — inference chain health, compute pool, CRDT, workspace info
pub fn run_status(worktree: Option<&Worktree>) -> Result<SlashCommandOutput, String> {
    let mut parts: Vec<String> = Vec::new();

    match companion_get("/health") {
        Ok(health_json) => {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&health_json) {
                let status = v["status"].as_str().unwrap_or("unknown");
                let version = v["version"].as_str().unwrap_or("?");
                let model = v["preferredModel"].as_str().unwrap_or("?");
                let mesh_peers = v["mesh"]["peerCount"].as_u64().unwrap_or(0);
                let mesh_models = v["mesh"]["totalModels"].as_u64().unwrap_or(0);
                let pool_joined = v["computePool"]["joined"].as_bool().unwrap_or(false);
                let pool_tokens = v["computePool"]["tokensEarned"].as_u64().unwrap_or(0);
                let crdt_peers = v["ghostwriter"]["crdt"]["peerCount"].as_u64().unwrap_or(0);
                let crdt_files: Vec<&str> = v["ghostwriter"]["crdt"]["openFiles"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|f| f.as_str()).collect())
                    .unwrap_or_default();
                let ucan_did = v["ghostwriter"]["ucan"]["did"].as_str().unwrap_or("none");

                parts.push(format!("## Zedge Companion v{version}"));
                parts.push(format!("**Status**: {status}"));
                parts.push(format!("**Model**: {model}"));
                parts.push(format!(
                    "**Mesh**: {mesh_peers} peers, {mesh_models} models"
                ));
                parts.push(format!(
                    "**Pool**: {} (tokens: {pool_tokens})",
                    if pool_joined { "joined" } else { "not joined" }
                ));
                parts.push(format!(
                    "**Ghostwriter CRDT**: {crdt_peers} peers, {} open files",
                    crdt_files.len()
                ));
                parts.push(format!("**UCAN DID**: `{ucan_did}`"));

                // Inference tiers
                let edge = v["inference"]["edgeAvailable"].as_bool().unwrap_or(false);
                let cloudrun = v["inference"]["cloudRunDirect"].as_bool().unwrap_or(false);
                let wasm = v["inference"]["wasmLocal"].as_bool().unwrap_or(false);
                parts.push(format!(
                    "**Inference**: edge={}, cloudrun={}, wasm={}",
                    if edge { "ok" } else { "off" },
                    if cloudrun { "ok" } else { "off" },
                    if wasm { "ok" } else { "off" },
                ));
            } else {
                parts.push(format!("```json\n{health_json}\n```"));
            }
        }
        Err(e) => {
            parts.push(format!("**Companion offline**: {e}"));
            parts.push(
                "Start with: `pnpm run gnode -- run open-source/zedge/companion/src/companion-supervisor.ts --export main`"
                    .to_string(),
            );
        }
    }

    // Workspace context from worktree (v0.7 feature)
    if let Some(wt) = worktree {
        let root = wt.root_path();
        parts.push(format!("\n**Workspace**: `{root}`"));

        if let Ok(aeon_toml) = wt.read_text_file("aeon.toml") {
            let lines: Vec<&str> = aeon_toml.lines().take(5).collect();
            parts.push(format!("**aeon.toml**:\n```\n{}\n```", lines.join("\n")));
        }
    }

    let text = parts.join("\n");
    Ok(output_with_section(text, "Zedge Status"))
}

/// /zedge-models — list available models with tier info
pub fn run_models() -> Result<SlashCommandOutput, String> {
    let mut parts: Vec<String> = Vec::new();

    match companion_get("/v1/models") {
        Ok(models_json) => {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&models_json) {
                parts.push("## Available Models\n".to_string());
                parts.push("| Model | Owner |".to_string());
                parts.push("|:---|:---|".to_string());

                if let Some(data) = v["data"].as_array() {
                    for model in data {
                        let id = model["id"].as_str().unwrap_or("?");
                        let owner = model["owned_by"].as_str().unwrap_or("?");
                        parts.push(format!("| `{id}` | {owner} |"));
                    }
                }

                parts.push("\n### Model Details\n".to_string());
                for m in provider::MODELS {
                    parts.push(format!(
                        "- **{}** (`{}`) — max {} tokens",
                        m.display_name, m.id, m.max_tokens
                    ));
                }
            } else {
                parts.push(format!("```json\n{models_json}\n```"));
            }
        }
        Err(e) => {
            parts.push(format!("**Companion offline**: {e}\n"));
            parts.push("Built-in model list:\n".to_string());
            for m in provider::MODELS {
                parts.push(format!("- **{}** (`{}`)", m.display_name, m.id));
            }
        }
    }

    let text = parts.join("\n");
    Ok(output_with_section(text, "Zedge Models"))
}

/// /zedge-pool — compute pool status and earnings
pub fn run_pool(args: &[String]) -> Result<SlashCommandOutput, String> {
    let subcommand = args
        .first()
        .map(|value| value.as_str())
        .unwrap_or("status");

    if subcommand == "join" {
        return match companion_post("/compute-pool/join") {
            Ok(body) => Ok(output_with_section(
                format!("## Compute Pool Join\n\n```json\n{body}\n```"),
                "Compute Pool",
            )),
            Err(e) => Ok(output_with_section(format!("**Error**: {e}"), "Compute Pool")),
        };
    }

    if subcommand == "leave" {
        return match companion_post("/compute-pool/leave") {
            Ok(body) => Ok(output_with_section(
                format!("## Compute Pool Leave\n\n```json\n{body}\n```"),
                "Compute Pool",
            )),
            Err(e) => Ok(output_with_section(format!("**Error**: {e}"), "Compute Pool")),
        };
    }

    let mut parts: Vec<String> = Vec::new();

    match companion_get("/compute-pool/status") {
        Ok(pool_json) => {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&pool_json) {
                let joined = v["joined"].as_bool().unwrap_or(false);
                let tokens = v["tokensEarned"].as_u64().unwrap_or(0);
                let requests = v["requestsServed"].as_u64().unwrap_or(0);
                let nodes = v["connectedNodes"].as_u64().unwrap_or(0);
                let wasm = v["wasmBridgeAvailable"].as_bool().unwrap_or(false);

                parts.push("## Compute Pool\n".to_string());
                parts.push(format!(
                    "**Status**: {}",
                    if joined { "Joined" } else { "Not joined" }
                ));
                parts.push(format!("**Tokens earned**: {tokens}"));
                parts.push(format!("**Requests served**: {requests}"));
                parts.push(format!("**Connected nodes**: {nodes}"));
                parts.push(format!(
                    "**WASM bridge**: {}",
                    if wasm { "available" } else { "unavailable" }
                ));
                parts.push("\n**Slash commands**: `/zedge-pool join`, `/zedge-pool leave`".to_string());
            } else {
                parts.push(format!("```json\n{pool_json}\n```"));
            }
        }
        Err(e) => {
            parts.push(format!("**Companion offline**: {e}"));
        }
    }

    let text = parts.join("\n");
    Ok(output_with_section(text, "Compute Pool"))
}

/// /zedge-logs — recent inference logs
pub fn run_logs() -> Result<SlashCommandOutput, String> {
    match companion_get("/logs?n=100") {
        Ok(logs_json) => {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&logs_json) {
                let mut parts: Vec<String> = Vec::new();
                let count = v["count"].as_u64().unwrap_or(0);
                parts.push(format!("## Inference Logs ({count} entries)\n"));
                parts.push("```".to_string());
                if let Some(lines) = v["lines"].as_array() {
                    for line in lines {
                        if let Some(s) = line.as_str() {
                            parts.push(s.to_string());
                        }
                    }
                }
                parts.push("```".to_string());
                let text = parts.join("\n");
                Ok(output_with_section(text, "Inference Logs"))
            } else {
                Ok(output_with_section(format!("```\n{logs_json}\n```"), "Inference Logs"))
            }
        }
        Err(e) => {
            Ok(output_with_section(
                format!("**Companion offline**: {e}\n\nStart with: `pnpm run gnode -- run open-source/zedge/companion/src/companion-supervisor.ts --export main`"),
                "Inference Logs",
            ))
        }
    }
}

/// /zedge-clear — clear inference logs
pub fn run_clear() -> Result<SlashCommandOutput, String> {
    match companion_delete("/logs") {
        Ok(_) => Ok(output_with_section(
            "Inference logs cleared.".to_string(),
            "Logs Cleared",
        )),
        Err(e) => Ok(output_with_section(
            format!("**Companion offline**: {e}"),
            "Logs Cleared",
        )),
    }
}

/// /zedge-restart — restart companion sidecar
pub fn run_restart() -> Result<SlashCommandOutput, String> {
    match companion_post("/restart") {
        Ok(_) => Ok(output_with_section(
            "Companion is restarting. It will be back in a few seconds.".to_string(),
            "Companion Restart",
        )),
        Err(e) => Ok(output_with_section(
            format!("**Companion offline**: {e}"),
            "Companion Restart",
        )),
    }
}

/// /zedge-selftest — live inference contract check
pub fn run_selftest(args: &[String]) -> Result<SlashCommandOutput, String> {
    let model = args
        .first()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let path = match model {
        Some(model_id) => format!("/selftest/inference?model={model_id}"),
        None => "/selftest/inference".to_string(),
    };

    match companion_get(&path) {
        Ok(body) => {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&body) {
                let mut parts: Vec<String> = Vec::new();
                let model_id = value["model"].as_str().unwrap_or("?");
                parts.push("## Inference Self-Test\n".to_string());
                parts.push(format!("**Model**: `{model_id}`"));

                let edge_models = &value["edgeModels"];
                parts.push(format!(
                    "**Edge /v1/models**: {} ({})",
                    edge_models["status"].as_i64().unwrap_or(0),
                    if edge_models["ok"].as_bool().unwrap_or(false) {
                        "ok"
                    } else {
                        "error"
                    }
                ));
                if let Some(error) = edge_models["error"].as_str() {
                    parts.push(format!("Edge error: `{error}`"));
                }

                if !value["cloudRunHealth"].is_null() {
                    let cloudrun = &value["cloudRunHealth"];
                    parts.push(format!(
                        "**Cloud Run health**: {} via `{}` (healthy={}, {}ms)",
                        cloudrun["status"].as_i64().unwrap_or(0),
                        cloudrun["url"].as_str().unwrap_or("?"),
                        cloudrun["healthy"].as_bool().unwrap_or(false),
                        cloudrun["latencyMs"].as_u64().unwrap_or(0)
                    ));
                }

                let companion = &value["companionStream"];
                parts.push(format!(
                    "**Companion stream**: {} content-type=`{}` prefill={} heartbeat={} data={} done={}",
                    companion["status"].as_i64().unwrap_or(0),
                    companion["contentType"].as_str().unwrap_or("?"),
                    companion["sawPrefill"].as_bool().unwrap_or(false),
                    companion["sawHeartbeat"].as_bool().unwrap_or(false),
                    companion["sawData"].as_bool().unwrap_or(false),
                    companion["sawDone"].as_bool().unwrap_or(false),
                ));
                if let Some(lines) = companion["sample"].as_array() {
                    parts.push("\n### Companion SSE sample".to_string());
                    parts.push("```".to_string());
                    for line in lines.iter().filter_map(|line| line.as_str()) {
                        parts.push(line.to_string());
                    }
                    parts.push("```".to_string());
                }
                if let Some(error) = companion["error"].as_str() {
                    parts.push(format!("Companion stream error: `{error}`"));
                }
                if let Some(preview) = companion["bodyPreview"].as_str() {
                    parts.push(format!("Companion body preview: ```\n{preview}\n```"));
                }

                if !value["directCloudRunStream"].is_null() {
                    let direct = &value["directCloudRunStream"];
                    parts.push(format!(
                        "\n**Direct Cloud Run stream**: {} content-type=`{}` prefill={} heartbeat={} data={} done={}",
                        direct["status"].as_i64().unwrap_or(0),
                        direct["contentType"].as_str().unwrap_or("?"),
                        direct["sawPrefill"].as_bool().unwrap_or(false),
                        direct["sawHeartbeat"].as_bool().unwrap_or(false),
                        direct["sawData"].as_bool().unwrap_or(false),
                        direct["sawDone"].as_bool().unwrap_or(false),
                    ));
                    if let Some(lines) = direct["sample"].as_array() {
                        parts.push("\n### Direct Cloud Run SSE sample".to_string());
                        parts.push("```".to_string());
                        for line in lines.iter().filter_map(|line| line.as_str()) {
                            parts.push(line.to_string());
                        }
                        parts.push("```".to_string());
                    }
                    if let Some(error) = direct["error"].as_str() {
                        parts.push(format!("Direct Cloud Run stream error: `{error}`"));
                    }
                    if let Some(preview) = direct["bodyPreview"].as_str() {
                        parts.push(format!("Direct Cloud Run body preview: ```\n{preview}\n```"));
                    }
                }

                Ok(output_with_section(parts.join("\n"), "Inference Self-Test"))
            } else {
                Ok(output_with_section(
                    format!("```\n{body}\n```"),
                    "Inference Self-Test",
                ))
            }
        }
        Err(error) => Ok(output_with_section(
            format!("**Companion unavailable**: {error}"),
            "Inference Self-Test",
        )),
    }
}

/// /zedgework — run edgework-cli commands (available to all users)
pub fn run_edgework(args: &[String]) -> Result<SlashCommandOutput, String> {
    if args.is_empty() {
        match companion_get("/edgework/commands") {
            Ok(cmds_json) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&cmds_json) {
                    let mut parts: Vec<String> = Vec::new();
                    parts.push("## Edgework Commands\n".to_string());
                    parts.push("Usage: `/zedgework <command> [args]`\n".to_string());
                    parts.push("| Command | Description |".to_string());
                    parts.push("|:---|:---|".to_string());
                    if let Some(commands) = v["commands"].as_array() {
                        for cmd in commands {
                            let name = cmd["name"].as_str().unwrap_or("?");
                            let desc = cmd["description"].as_str().unwrap_or("");
                            let cmd_args = cmd["args"].as_str().unwrap_or("");
                            let display = if cmd_args.is_empty() {
                                format!("`{name}`")
                            } else {
                                format!("`{name} {cmd_args}`")
                            };
                            parts.push(format!("| {display} | {desc} |"));
                        }
                    }
                    let text = parts.join("\n");
                    Ok(output_with_section(text, "Edgework"))
                } else {
                    Ok(output_with_section(
                        format!("```\n{cmds_json}\n```"),
                        "Edgework",
                    ))
                }
            }
            Err(e) => Ok(output_with_section(
                format!("**Companion offline**: {e}"),
                "Edgework",
            )),
        }
    } else {
        let edgework_cmd = format!("edgework {}", args.join(" "));
        let body = serde_json::json!({ "command": edgework_cmd });
        let url = format!("{}/edgework/exec", provider::COMPANION_URL);

        match HttpRequest::builder()
            .method(HttpMethod::Post)
            .url(&url)
            .header("Content-Type", "application/json")
            .body(body.to_string().into_bytes())
            .redirect_policy(RedirectPolicy::FollowAll)
            .build()
            .and_then(|req| req.fetch().map_err(|e| format!("{e}")))
        {
            Ok(response) => {
                let response_text = String::from_utf8(response.body)
                    .unwrap_or_else(|_| "Invalid UTF-8".to_string());
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&response_text) {
                    let exit_code = v["exitCode"].as_i64().unwrap_or(-1);
                    let output = v["output"].as_str().unwrap_or("");
                    let cmd = v["command"].as_str().unwrap_or(&edgework_cmd);
                    let status = if exit_code == 0 { "ok" } else { "error" };
                    let text = format!("## `{cmd}` [{status}]\n\n```\n{output}\n```");
                    Ok(output_with_section(text, &format!("edgework {}", args[0])))
                } else {
                    Ok(output_with_section(
                        format!("```\n{response_text}\n```"),
                        "Edgework",
                    ))
                }
            }
            Err(e) => Ok(output_with_section(
                format!("**Companion offline**: {e}"),
                "Edgework",
            )),
        }
    }
}

/// /zedge-admin — run aeon-cli admin commands
pub fn run_admin(args: &[String]) -> Result<SlashCommandOutput, String> {
    // No args = show available commands
    if args.is_empty() {
        match companion_get("/admin/commands") {
            Ok(cmds_json) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&cmds_json) {
                    let mut parts: Vec<String> = Vec::new();
                    parts.push("## Aeon Admin Commands\n".to_string());
                    parts.push("Usage: `/zedge-admin <command>`\n".to_string());
                    parts.push("| Command | Description | Risk |".to_string());
                    parts.push("|:---|:---|:---|".to_string());
                    if let Some(commands) = v["commands"].as_array() {
                        for cmd in commands {
                            let name = cmd["name"].as_str().unwrap_or("?");
                            let desc = cmd["description"].as_str().unwrap_or("");
                            let risk = cmd["risk"].as_str().unwrap_or("read");
                            parts.push(format!("| `{name}` | {desc} | {risk} |"));
                        }
                    }
                    let text = parts.join("\n");
                    Ok(output_with_section(text, "Aeon Admin"))
                } else {
                    Ok(output_with_section(
                        format!("```\n{cmds_json}\n```"),
                        "Aeon Admin",
                    ))
                }
            }
            Err(e) => Ok(output_with_section(
                format!("**Companion offline**: {e}"),
                "Aeon Admin",
            )),
        }
    } else {
        // Execute the command
        let aeon_cmd = format!("aeon {}", args.join(" "));
        let body = serde_json::json!({ "command": aeon_cmd });
        let url = format!("{}/admin/exec", provider::COMPANION_URL);

        match HttpRequest::builder()
            .method(HttpMethod::Post)
            .url(&url)
            .header("Content-Type", "application/json")
            .body(body.to_string().into_bytes())
            .redirect_policy(RedirectPolicy::FollowAll)
            .build()
            .and_then(|req| req.fetch().map_err(|e| format!("{e}")))
        {
            Ok(response) => {
                let response_text = String::from_utf8(response.body)
                    .unwrap_or_else(|_| "Invalid UTF-8".to_string());
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&response_text) {
                    let exit_code = v["exitCode"].as_i64().unwrap_or(-1);
                    let output = v["output"].as_str().unwrap_or("");
                    let cmd = v["command"].as_str().unwrap_or(&aeon_cmd);
                    let status = if exit_code == 0 { "ok" } else { "error" };
                    let text = format!("## `{cmd}` [{status}]\n\n```\n{output}\n```");
                    Ok(output_with_section(text, &format!("aeon {}", args[0])))
                } else {
                    Ok(output_with_section(
                        format!("```\n{response_text}\n```"),
                        "Aeon Admin",
                    ))
                }
            }
            Err(e) => Ok(output_with_section(
                format!("**Companion offline**: {e}"),
                "Aeon Admin",
            )),
        }
    }
}

/// /zedge-mesh — P2P inference mesh control
pub fn run_mesh(args: &[String]) -> Result<SlashCommandOutput, String> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("status");
    match sub {
        "start" => match companion_post("/mesh/start") {
            Ok(body) => Ok(output_with_section(
                format!("Mesh started.\n\n```json\n{body}\n```"),
                "Mesh Start",
            )),
            Err(e) => Ok(output_with_section(format!("**Error**: {e}"), "Mesh Start")),
        },
        "stop" => match companion_post("/mesh/stop") {
            Ok(body) => Ok(output_with_section(
                format!("Mesh stopped.\n\n```json\n{body}\n```"),
                "Mesh Stop",
            )),
            Err(e) => Ok(output_with_section(format!("**Error**: {e}"), "Mesh Stop")),
        },
        _ => match companion_get("/mesh/status") {
            Ok(body) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                    let running = v["running"].as_bool().unwrap_or(false);
                    let peers = v["peers"].as_array().map(|a| a.len()).unwrap_or(0);
                    let node_id = v["nodeId"].as_str().unwrap_or("none");
                    let mut parts = vec![
                        "## P2P Inference Mesh\n".to_string(),
                        format!(
                            "**Status**: {}",
                            if running { "running" } else { "stopped" }
                        ),
                        format!("**Node ID**: `{node_id}`"),
                        format!("**Peers**: {peers}"),
                    ];
                    if !running {
                        parts.push("\nStart with: `/zedge-mesh start`".to_string());
                    }
                    Ok(output_with_section(parts.join("\n"), "Mesh"))
                } else {
                    Ok(output_with_section(format!("```json\n{body}\n```"), "Mesh"))
                }
            }
            Err(e) => Ok(output_with_section(
                format!("**Companion offline**: {e}"),
                "Mesh",
            )),
        },
    }
}

/// /zedge-crdt — Ghostwriter CRDT collaboration
pub fn run_crdt(args: &[String]) -> Result<SlashCommandOutput, String> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("status");
    match sub {
        "files" => match companion_get("/crdt/files") {
            Ok(body) => Ok(output_with_section(
                format!("## Open CRDT Files\n\n```json\n{body}\n```"),
                "CRDT Files",
            )),
            Err(e) => Ok(output_with_section(format!("**Error**: {e}"), "CRDT Files")),
        },
        "cursors" => match companion_get("/crdt/cursors") {
            Ok(body) => Ok(output_with_section(
                format!("## Active Cursors\n\n```json\n{body}\n```"),
                "CRDT Cursors",
            )),
            Err(e) => Ok(output_with_section(
                format!("**Error**: {e}"),
                "CRDT Cursors",
            )),
        },
        "participants" => match companion_get("/crdt/participants") {
            Ok(body) => Ok(output_with_section(
                format!("## Participants\n\n```json\n{body}\n```"),
                "CRDT Participants",
            )),
            Err(e) => Ok(output_with_section(
                format!("**Error**: {e}"),
                "CRDT Participants",
            )),
        },
        "ledger" => match companion_get("/crdt/ledger") {
            Ok(body) => Ok(output_with_section(
                format!("## Contribution Ledger\n\n```json\n{body}\n```"),
                "CRDT Ledger",
            )),
            Err(e) => Ok(output_with_section(
                format!("**Error**: {e}"),
                "CRDT Ledger",
            )),
        },
        "diagnostics" => match companion_get("/crdt/diagnostics") {
            Ok(body) => Ok(output_with_section(
                format!("## CRDT Diagnostics\n\n```json\n{body}\n```"),
                "CRDT Diagnostics",
            )),
            Err(e) => Ok(output_with_section(
                format!("**Error**: {e}"),
                "CRDT Diagnostics",
            )),
        },
        _ => match companion_get("/crdt/status") {
            Ok(body) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                    let peers = v["peerCount"].as_u64().unwrap_or(0);
                    let files: Vec<&str> = v["openFiles"]
                        .as_array()
                        .map(|a| a.iter().filter_map(|f| f.as_str()).collect())
                        .unwrap_or_default();
                    let mut parts = vec![
                        "## Ghostwriter CRDT\n".to_string(),
                        format!("**Peers**: {peers}"),
                        format!(
                            "**Open files**: {}",
                            if files.is_empty() {
                                "none".to_string()
                            } else {
                                files.join(", ")
                            }
                        ),
                    ];
                    parts.push("\n**Subcommands**: `files`, `cursors`, `participants`, `ledger`, `diagnostics`".to_string());
                    Ok(output_with_section(parts.join("\n"), "CRDT"))
                } else {
                    Ok(output_with_section(format!("```json\n{body}\n```"), "CRDT"))
                }
            }
            Err(e) => Ok(output_with_section(
                format!("**Companion offline**: {e}"),
                "CRDT",
            )),
        },
    }
}

/// /zedge-forge — ForgeCD deployment
pub fn run_forge(args: &[String]) -> Result<SlashCommandOutput, String> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("status");
    match sub {
        "projects" => match companion_get("/forge/projects") {
            Ok(body) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                    let mut parts = vec!["## Forge Projects\n".to_string()];
                    if let Some(projects) = v["projects"].as_array() {
                        parts.push("| Name | Kind | Status |".to_string());
                        parts.push("|:---|:---|:---|".to_string());
                        for p in projects {
                            let name = p["name"].as_str().unwrap_or("?");
                            let kind = p["kind"].as_str().unwrap_or("?");
                            let status = p["status"].as_str().unwrap_or("?");
                            parts.push(format!("| `{name}` | {kind} | {status} |"));
                        }
                    }
                    Ok(output_with_section(parts.join("\n"), "Forge Projects"))
                } else {
                    Ok(output_with_section(
                        format!("```json\n{body}\n```"),
                        "Forge Projects",
                    ))
                }
            }
            Err(e) => Ok(output_with_section(
                format!("**Error**: {e}"),
                "Forge Projects",
            )),
        },
        "deploy" => {
            // Need a project name as second arg
            let project = args.get(1).map(|s| s.as_str()).unwrap_or("");
            if project.is_empty() {
                return Ok(output_with_section(
                    "Usage: `/zedge-forge deploy <project-name>`\n\nList projects: `/zedge-forge projects`".to_string(),
                    "Forge Deploy",
                ));
            }
            let body = serde_json::json!({ "project": project });
            let url = format!("{}/forge/deploy", provider::COMPANION_URL);
            match HttpRequest::builder()
                .method(HttpMethod::Post)
                .url(&url)
                .header("Content-Type", "application/json")
                .body(body.to_string().into_bytes())
                .redirect_policy(RedirectPolicy::FollowAll)
                .build()
                .and_then(|req| req.fetch().map_err(|e| format!("{e}")))
            {
                Ok(response) => {
                    let text = String::from_utf8(response.body).unwrap_or_default();
                    Ok(output_with_section(
                        format!("## Deploying `{project}`\n\n```json\n{text}\n```"),
                        "Forge Deploy",
                    ))
                }
                Err(e) => Ok(output_with_section(
                    format!("**Error**: {e}"),
                    "Forge Deploy",
                )),
            }
        }
        _ => match companion_get("/forge/status") {
            Ok(body) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                    let mut parts = vec!["## ForgeCD Status\n".to_string()];
                    parts.push(format!(
                        "```json\n{}\n```",
                        serde_json::to_string_pretty(&v).unwrap_or(body.clone())
                    ));
                    parts.push("\n**Subcommands**: `projects`, `deploy <name>`".to_string());
                    Ok(output_with_section(parts.join("\n"), "Forge"))
                } else {
                    Ok(output_with_section(
                        format!("```json\n{body}\n```"),
                        "Forge",
                    ))
                }
            }
            Err(e) => Ok(output_with_section(
                format!("**Companion offline**: {e}"),
                "Forge",
            )),
        },
    }
}

/// /zedge-kernel — Kernel daemon management
pub fn run_kernel(args: &[String]) -> Result<SlashCommandOutput, String> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("status");
    match sub {
        "daemons" => match companion_get("/kernel/daemons") {
            Ok(body) => Ok(output_with_section(
                format!("## Kernel Daemons\n\n```json\n{body}\n```"),
                "Kernel Daemons",
            )),
            Err(e) => Ok(output_with_section(
                format!("**Error**: {e}"),
                "Kernel Daemons",
            )),
        },
        "plugins" => match companion_get("/kernel/plugins") {
            Ok(body) => Ok(output_with_section(
                format!("## Kernel Plugins\n\n```json\n{body}\n```"),
                "Kernel Plugins",
            )),
            Err(e) => Ok(output_with_section(
                format!("**Error**: {e}"),
                "Kernel Plugins",
            )),
        },
        "commands" => match companion_get("/kernel/commands") {
            Ok(body) => Ok(output_with_section(
                format!("## Kernel Commands\n\n```json\n{body}\n```"),
                "Kernel Commands",
            )),
            Err(e) => Ok(output_with_section(
                format!("**Error**: {e}"),
                "Kernel Commands",
            )),
        },
        "flight-log" => match companion_get("/kernel/flight-log") {
            Ok(body) => Ok(output_with_section(
                format!("## Flight Log\n\n```json\n{body}\n```"),
                "Flight Log",
            )),
            Err(e) => Ok(output_with_section(format!("**Error**: {e}"), "Flight Log")),
        },
        _ => {
            // Default: show daemons + plugins as combined status
            let daemons = companion_get("/kernel/daemons").unwrap_or_else(|_| "[]".to_string());
            let plugins = companion_get("/kernel/plugins").unwrap_or_else(|_| "[]".to_string());
            let mut parts = vec!["## Kernel Status\n".to_string()];
            parts.push(format!("### Daemons\n```json\n{daemons}\n```"));
            parts.push(format!("\n### Plugins\n```json\n{plugins}\n```"));
            parts.push(
                "\n**Subcommands**: `daemons`, `plugins`, `commands`, `flight-log`".to_string(),
            );
            Ok(output_with_section(parts.join("\n"), "Kernel"))
        }
    }
}

/// /zedge-scaffold — create new projects from templates
pub fn run_scaffold(args: &[String]) -> Result<SlashCommandOutput, String> {
    if args.is_empty() {
        // List available templates
        match companion_get("/scaffold/templates") {
            Ok(body) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                    let mut parts = vec![
                        "## Project Templates\n".to_string(),
                        "Usage: `/zedge-scaffold <template> <project-name>`\n".to_string(),
                        "| Template | Description |".to_string(),
                        "|:---|:---|".to_string(),
                    ];
                    if let Some(templates) = v["templates"].as_array() {
                        for t in templates {
                            let name = t["name"].as_str().unwrap_or("?");
                            let desc = t["description"].as_str().unwrap_or("");
                            parts.push(format!("| `{name}` | {desc} |"));
                        }
                    }
                    Ok(output_with_section(parts.join("\n"), "Scaffold"))
                } else {
                    Ok(output_with_section(format!("```\n{body}\n```"), "Scaffold"))
                }
            }
            Err(e) => Ok(output_with_section(
                format!("**Companion offline**: {e}"),
                "Scaffold",
            )),
        }
    } else {
        let template = &args[0];
        let name = args.get(1).map(|s| s.as_str()).unwrap_or("");
        if name.is_empty() {
            return Ok(output_with_section(
                format!("Usage: `/zedge-scaffold {template} <project-name>`"),
                "Scaffold",
            ));
        }
        let body = serde_json::json!({ "template": template, "name": name });
        let url = format!("{}/scaffold/create", provider::COMPANION_URL);
        match HttpRequest::builder()
            .method(HttpMethod::Post)
            .url(&url)
            .header("Content-Type", "application/json")
            .body(body.to_string().into_bytes())
            .redirect_policy(RedirectPolicy::FollowAll)
            .build()
            .and_then(|req| req.fetch().map_err(|e| format!("{e}")))
        {
            Ok(response) => {
                let text = String::from_utf8(response.body).unwrap_or_default();
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                    let exit_code = v["exitCode"].as_i64().unwrap_or(-1);
                    let output = v["output"].as_str().unwrap_or("");
                    let status = if exit_code == 0 { "ok" } else { "error" };
                    Ok(output_with_section(
                        format!(
                            "## Scaffold `{template}` → `{name}` [{status}]\n\n```\n{output}\n```"
                        ),
                        &format!("Scaffold {template}"),
                    ))
                } else {
                    Ok(output_with_section(format!("```\n{text}\n```"), "Scaffold"))
                }
            }
            Err(e) => Ok(output_with_section(format!("**Error**: {e}"), "Scaffold")),
        }
    }
}

/// /zedge-gnosis — evaluate Gnosis topological graph
pub fn run_gnosis(args: &[String]) -> Result<SlashCommandOutput, String> {
    if args.is_empty() {
        return Ok(output_with_section(
            "Usage: `/zedge-gnosis <topological-graph-string>`\nExample: `/zedge-gnosis (input)-[:FORK]->(a|b)`".to_string(),
            "Gnosis",
        ));
    }

    let code = args.join(" ");
    let body = serde_json::json!({ "code": code });
    let url = format!("{}/gnosis/eval", provider::COMPANION_URL);

    match HttpRequest::builder()
        .method(HttpMethod::Post)
        .url(&url)
        .header("Content-Type", "application/json")
        .body(body.to_string().into_bytes())
        .redirect_policy(RedirectPolicy::FollowAll)
        .build()
        .and_then(|req| req.fetch().map_err(|e| format!("{e}")))
    {
        Ok(response) => {
            let response_text =
                String::from_utf8(response.body).unwrap_or_else(|_| "Invalid UTF-8".to_string());
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&response_text) {
                let output = v["output"].as_str().unwrap_or("");
                let b1 = v["b1"].as_u64().unwrap_or(0);
                let buley = v["buleyMeasure"].as_f64().unwrap_or(0.0);
                let diagnostics = v["diagnostics"].as_array();
                let diagnostics_count = diagnostics.map(|items| items.len()).unwrap_or(0);
                let diagnostics_preview = diagnostics
                    .map(|items| {
                        items
                            .iter()
                            .take(3)
                            .filter_map(|item| item["message"].as_str())
                            .map(|message| format!("- {message}"))
                            .collect::<Vec<String>>()
                            .join("\n")
                    })
                    .unwrap_or_default();

                let diagnostics_block = if diagnostics_count > 0 {
                    format!("\n\n**Diagnostics**: {diagnostics_count}\n{diagnostics_preview}")
                } else {
                    "\n\n**Diagnostics**: 0".to_string()
                };

                let text = format!(
                    "## Gnosis Evaluation\n\n**Betti Number (β₁)**: {b1}\n**Buley Measure**: {buley:.2}{diagnostics_block}\n\n```\n{output}\n```"
                );
                Ok(output_with_section(text, "Gnosis"))
            } else {
                Ok(output_with_section(
                    format!("```\n{response_text}\n```"),
                    "Gnosis",
                ))
            }
        }
        Err(e) => Ok(output_with_section(
            format!("**Companion offline**: {e}"),
            "Gnosis",
        )),
    }
}

/// /zedge-gnosis-run — evaluate current Gnosis file
pub fn run_gnosis_run(worktree: Option<&Worktree>) -> Result<SlashCommandOutput, String> {
    let wt = worktree.ok_or("No active workspace")?;
    // In a real Zed extension we would get the active buffer path.
    // For now we look for any .gg file in the root as a fallback.
    let files = wt
        .read_text_file("main.gg")
        .or_else(|_| wt.read_text_file("example.gg"))
        .map_err(|_| "Could not find main.gg or example.gg to run")?;

    let body = serde_json::json!({ "code": files });
    let url = format!("{}/gnosis/eval", provider::COMPANION_URL);

    match HttpRequest::builder()
        .method(HttpMethod::Post)
        .url(&url)
        .header("Content-Type", "application/json")
        .body(body.to_string().into_bytes())
        .redirect_policy(RedirectPolicy::FollowAll)
        .build()
        .and_then(|req| req.fetch().map_err(|e| format!("{e}")))
    {
        Ok(response) => {
            let response_text =
                String::from_utf8(response.body).unwrap_or_else(|_| "Invalid UTF-8".to_string());
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&response_text) {
                let output = v["output"].as_str().unwrap_or("");
                let b1 = v["b1"].as_u64().unwrap_or(0);
                let buley = v["buleyMeasure"].as_f64().unwrap_or(0.0);
                let diagnostics = v["diagnostics"].as_array();
                let diagnostics_count = diagnostics.map(|items| items.len()).unwrap_or(0);
                let diagnostics_preview = diagnostics
                    .map(|items| {
                        items
                            .iter()
                            .take(3)
                            .filter_map(|item| item["message"].as_str())
                            .map(|message| format!("- {message}"))
                            .collect::<Vec<String>>()
                            .join("\n")
                    })
                    .unwrap_or_default();

                let diagnostics_block = if diagnostics_count > 0 {
                    format!("\n\n**Diagnostics**: {diagnostics_count}\n{diagnostics_preview}")
                } else {
                    "\n\n**Diagnostics**: 0".to_string()
                };

                let text = format!(
                    "## Gnosis Run Results\n\n**Betti Number (β₁)**: {b1}\n**Buley Measure**: {buley:.2}{diagnostics_block}\n\n```\n{output}\n```"
                );
                Ok(output_with_section(text, "Gnosis Run"))
            } else {
                Ok(output_with_section(
                    format!("```\n{response_text}\n```"),
                    "Gnosis Run",
                ))
            }
        }
        Err(e) => Ok(output_with_section(
            format!("**Companion offline**: {e}"),
            "Gnosis Run",
        )),
    }
}

/// /zedge-gnosis-viz — open topology visualization in browser
pub fn run_gnosis_viz(worktree: Option<&Worktree>) -> Result<SlashCommandOutput, String> {
    let mut parts: Vec<String> = Vec::new();

    let file_path = if let Some(wt) = worktree {
        // Try to find an active .ts or .gg file
        wt.read_text_file("main.ts")
            .map(|_| "main.ts".to_string())
            .or_else(|_| {
                wt.read_text_file("index.ts")
                    .map(|_| "index.ts".to_string())
            })
            .unwrap_or_default()
    } else {
        String::new()
    };

    let viz_url = if file_path.is_empty() {
        format!("{}/gnosis/viz", provider::COMPANION_URL)
    } else {
        format!("{}/gnosis/viz?file={}", provider::COMPANION_URL, file_path)
    };

    parts.push("## Gnosis Topology Visualization\n".to_string());
    parts.push(format!("Open in browser: {viz_url}\n"));
    parts.push("The visualization shows:".to_string());
    parts.push("- **Nodes**: color-coded by kind (entry, call, assign, return, join)".to_string());
    parts.push("- **Edges**: color-coded by type (FORK, RACE, FOLD, PROCESS, VENT, INTERFERE)".to_string());
    parts.push("- **Metrics HUD**: Buley number, Wallace number, steering regime, beta-1".to_string());
    parts.push("- **Interactive**: hover for details, click to navigate to source".to_string());

    let text = parts.join("\n");
    Ok(output_with_section(text, "Gnosis Visualization"))
}

/// /zedge-test — run isolated tests via Gnosis
pub fn run_test(worktree: Option<&Worktree>) -> Result<SlashCommandOutput, String> {
    let wt = worktree.ok_or("No active workspace")?;

    // Path to the Gnosis isolation runner
    let runner_path = "open-source/gnosis/topologies/services/isolation-tests.gg";
    let runner_code = wt
        .read_text_file(runner_path)
        .map_err(|_| format!("Could not find Gnosis isolation runner at {}", runner_path))?;

    let body = serde_json::json!({ "code": runner_code });
    let url = format!("{}/gnosis/eval", provider::COMPANION_URL);

    match HttpRequest::builder()
        .method(HttpMethod::Post)
        .url(&url)
        .header("Content-Type", "application/json")
        .body(body.to_string().into_bytes())
        .redirect_policy(RedirectPolicy::FollowAll)
        .build()
        .and_then(|req| req.fetch().map_err(|e| format!("{e}")))
    {
        Ok(response) => {
            let response_text =
                String::from_utf8(response.body).unwrap_or_else(|_| "Invalid UTF-8".to_string());
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&response_text) {
                let output = v["output"].as_str().unwrap_or("");
                let b1 = v["b1"].as_u64().unwrap_or(0);

                let status = if b1 == 0 {
                    "✅ VERIFIED"
                } else {
                    "⚠️ TOPOLOGY LEAK"
                };
                let text = format!("## Gnosis Isolation Test Run\n\n**Status**: {status}\n**Betti Number (β₁)**: {b1}\n\n```\n{output}\n```");
                Ok(output_with_section(text, "Zedge Test"))
            } else {
                Ok(output_with_section(
                    format!("```\n{response_text}\n```"),
                    "Zedge Test",
                ))
            }
        }
        Err(e) => Ok(output_with_section(
            format!("**Companion offline**: {e}"),
            "Zedge Test",
        )),
    }
}

/// /zedge-feedback — local RLHF quality feedback
pub fn run_feedback(args: &[String]) -> Result<SlashCommandOutput, String> {
    if args.is_empty() {
        return match companion_get("/feedback?n=10") {
            Ok(body) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&body) {
                    let mut parts = vec![
                        "## Zedge Feedback\n".to_string(),
                        "Usage: `/zedge-feedback <rating 1-5> [comment]`\n".to_string(),
                    ];
                    let count = value["count"].as_u64().unwrap_or(0);
                    parts.push(format!("**Recent entries**: {count}"));
                    if let Some(entries) = value["entries"].as_array() {
                        for entry in entries.iter().rev().take(10) {
                            let rating = entry["rating"].as_i64().unwrap_or(0);
                            let comment = entry["comment"].as_str().unwrap_or("");
                            let timestamp = entry["timestamp"].as_str().unwrap_or("?");
                            let model = entry["model"].as_str().unwrap_or("");
                            let model_suffix = if model.is_empty() {
                                String::new()
                            } else {
                                format!(" model=`{model}`")
                            };
                            parts.push(format!(
                                "- `{timestamp}` rating={rating}{model_suffix} {comment}"
                            ));
                        }
                    }
                    Ok(output_with_section(parts.join("\n"), "Zedge Feedback"))
                } else {
                    Ok(output_with_section(format!("```\n{body}\n```"), "Zedge Feedback"))
                }
            }
            Err(error) => Ok(output_with_section(
                format!("**Companion unavailable**: {error}"),
                "Zedge Feedback",
            )),
        };
    }

    let rating = match args[0].parse::<u8>() {
        Ok(value) if (1..=5).contains(&value) => value,
        _ => {
            return Ok(output_with_section(
                "Usage: `/zedge-feedback <rating 1-5> [comment]`".to_string(),
                "Zedge Feedback",
            ))
        }
    };

    let comment = if args.len() > 1 {
        Some(args[1..].join(" "))
    } else {
        None
    };

    let mut body = serde_json::json!({
        "rating": rating,
        "source": "zed-extension",
    });
    if let Some(comment_text) = comment
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        body["comment"] = serde_json::Value::String(comment_text.to_string());
    }

    match companion_post_json("/feedback", body) {
        Ok(response) => Ok(output_with_section(
            format!("## Feedback Recorded\n\n```json\n{response}\n```"),
            "Zedge Feedback",
        )),
        Err(error) => Ok(output_with_section(
            format!("**Companion unavailable**: {error}"),
            "Zedge Feedback",
        )),
    }
}

pub fn run_babelfish(
    args: &[String],
    worktree: Option<&Worktree>,
) -> Result<SlashCommandOutput, String> {
    if args.is_empty() || args[0] == "capabilities" {
        match companion_get("/babelfish/capabilities") {
            Ok(body) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                    let mut parts = vec![
                        "## Zedge Babelfish".to_string(),
                        format!(
                            "**Registry source**: `{}`",
                            v["registrySource"].as_str().unwrap_or("unknown")
                        ),
                        "\n### Programming Languages".to_string(),
                        "| Language | Analyze | Explain | Translate | Scaffold | Rewrite Preview |"
                            .to_string(),
                        "|:---|:---|:---|:---|:---|:---|".to_string(),
                    ];

                    if let Some(languages) = v["languages"].as_array() {
                        for language in languages {
                            let id = language["id"].as_str().unwrap_or("?");
                            let ops = &language["operations"];
                            parts.push(format!(
                                "| `{}` | {} | {} | {} | {} | {} |",
                                id,
                                ops["analyze"].as_str().unwrap_or("?"),
                                ops["explain"].as_str().unwrap_or("?"),
                                ops["translate"].as_str().unwrap_or("?"),
                                ops["scaffold"].as_str().unwrap_or("?"),
                                ops["rewritePreview"].as_str().unwrap_or("?"),
                            ));
                        }
                    }

                    parts.push("\n### Human Languages".to_string());
                    if let Some(human_languages) = v["humanLanguages"].as_array() {
                        for language in human_languages {
                            let code = language["code"].as_str().unwrap_or("?");
                            let name = language["name"].as_str().unwrap_or("?");
                            let status = language["status"].as_str().unwrap_or("?");
                            parts.push(format!("- `{code}` — {name} ({status})"));
                        }
                    }

                    return Ok(output_with_section(parts.join("\n"), "Babelfish"));
                }
                Ok(output_with_section(format!("```json\n{body}\n```"), "Babelfish"))
            }
            Err(e) => Ok(output_with_section(format!("**Companion offline**: {e}"), "Babelfish")),
        }
    } else {
        let subcommand = args[0].as_str();
        match subcommand {
            "apply" => {
                let preview_id = args.get(1).ok_or("Usage: `/zedge-babelfish apply <preview-id> [rewrite_in_place|generate_files]`")?;
                let apply_mode = args.get(2).map(|s| s.as_str()).unwrap_or("rewrite_in_place");
                let body = serde_json::json!({
                    "previewId": preview_id,
                    "applyMode": apply_mode,
                });
                let response = companion_post_json("/babelfish/code/apply", body)?;
                return Ok(output_with_section(
                    format!("## Babelfish Apply\n\n```json\n{response}\n```"),
                    "Babelfish Apply",
                ));
            }
            "translate-code" | "generate" | "rewrite-preview" => {
                let target_language = args.get(1).ok_or(
                    "Usage: `/zedge-babelfish <translate-code|generate|rewrite-preview> <target-language> <file-path>`",
                )?;
                let file_path = args.get(2).ok_or(
                    "Usage: `/zedge-babelfish <translate-code|generate|rewrite-preview> <target-language> <file-path>`",
                )?;
                let wt = worktree.ok_or("No active workspace")?;
                let source_text = wt
                    .read_text_file(file_path)
                    .map_err(|_| format!("Could not read `{file_path}` from the current workspace"))?;
                let output_mode = if subcommand == "generate" {
                    "generate_files"
                } else if subcommand == "rewrite-preview" {
                    "rewrite_in_place_requested"
                } else {
                    "preview"
                };
                let body = serde_json::json!({
                    "scope": {
                        "kind": "file",
                        "filePath": file_path,
                        "sourceText": source_text,
                    },
                    "targetLanguage": target_language,
                    "mode": subcommand,
                    "outputMode": output_mode,
                });
                let response = companion_post_json("/babelfish/code/preview", body)?;
                return Ok(output_with_section(
                    format!("## Babelfish {subcommand}\n\n```json\n{response}\n```"),
                    "Babelfish Preview",
                ));
            }
            "translate-text" => {
                let target_language = args
                    .get(1)
                    .ok_or("Usage: `/zedge-babelfish translate-text <target-language> <file-path>`")?;
                let file_path = args
                    .get(2)
                    .ok_or("Usage: `/zedge-babelfish translate-text <target-language> <file-path>`")?;
                let wt = worktree.ok_or("No active workspace")?;
                let source_text = wt
                    .read_text_file(file_path)
                    .map_err(|_| format!("Could not read `{file_path}` from the current workspace"))?;
                let body = serde_json::json!({
                    "scope": {
                        "kind": "file",
                        "filePath": file_path,
                        "sourceText": source_text,
                    },
                    "targetHumanLanguage": target_language,
                    "includeComments": true,
                    "includeDiagnostics": true,
                    "includeMarkdown": true,
                });
                let response = companion_post_json("/babelfish/text/translate", body)?;
                return Ok(output_with_section(
                    format!("## Babelfish Text Translation\n\n```json\n{response}\n```"),
                    "Babelfish Text",
                ));
            }
            "explain" => {
                let file_path = args
                    .get(1)
                    .ok_or("Usage: `/zedge-babelfish explain <file-path> [audience-language]`")?;
                let audience_language = args.get(2).map(|s| s.as_str()).unwrap_or("en");
                let wt = worktree.ok_or("No active workspace")?;
                let source_text = wt
                    .read_text_file(file_path)
                    .map_err(|_| format!("Could not read `{file_path}` from the current workspace"))?;
                let body = serde_json::json!({
                    "scope": {
                        "kind": "file",
                        "filePath": file_path,
                        "sourceText": source_text,
                    },
                    "audienceLanguage": audience_language,
                    "includeGg": true,
                });
                let response = companion_post_json("/babelfish/explain", body)?;
                return Ok(output_with_section(
                    format!("## Babelfish Explain\n\n```json\n{response}\n```"),
                    "Babelfish Explain",
                ));
            }
            _ => Ok(output_with_section(
                "Usage:\n- `/zedge-babelfish capabilities`\n- `/zedge-babelfish explain <file-path> [audience-language]`\n- `/zedge-babelfish translate-code <target-language> <file-path>`\n- `/zedge-babelfish translate-text <target-language> <file-path>`\n- `/zedge-babelfish generate <target-language> <file-path>`\n- `/zedge-babelfish rewrite-preview <target-language> <file-path>`\n- `/zedge-babelfish apply <preview-id> [rewrite_in_place|generate_files]`"
                    .to_string(),
                "Babelfish",
            )),
        }
    }
}

/// /zedge-cera — CERA perturbation engine control
///
/// Subcommands:
///   status     — CERA cycle status + void map stats + daydream state
///   mutations  — pending mutations with entropy scores
///   accept <id> — accept mutation
///   reject <id> — reject mutation
///   history    — recent graduated mutations
///   daydream   — daydream status, cached candidates, learned patterns
pub fn run_cera(args: &str) -> Result<SlashCommandOutput, String> {
    let parts: Vec<&str> = args.trim().splitn(2, ' ').collect();
    let subcommand = parts.first().unwrap_or(&"status");

    match *subcommand {
        "status" => {
            let body = companion_get("/cera/status")?;
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                let pending = v["pendingMutations"].as_u64().unwrap_or(0);
                let graduated = v["totalGraduated"].as_u64().unwrap_or(0);
                let rejected = v["totalRejected"].as_u64().unwrap_or(0);
                let accepted = v["totalAccepted"].as_u64().unwrap_or(0);
                let rounds = v["voidMapDensity"]["rounds"].as_u64().unwrap_or(0);
                let entropy = v["voidMapDensity"]["entropy"].as_f64().unwrap_or(0.0);
                let connected = v["connected"].as_bool().unwrap_or(false);

                let text = format!(
                    "## CERA Perturbation Engine\n\n\
                     **Connected**: {}\n\
                     **Pending mutations**: {}\n\
                     **Graduated**: {} | **Accepted**: {} | **Rejected**: {}\n\n\
                     ### Void Map\n\
                     **Rounds**: {} | **Entropy**: {:.3}\n\
                     **Complement weights**: {}",
                    if connected { "Yes" } else { "No" },
                    pending, graduated, accepted, rejected,
                    rounds, entropy,
                    v["voidMapDensity"]["complementWeights"]
                );
                Ok(output_with_section(text, "Zedge CERA"))
            } else {
                Ok(output_with_section(format!("```\n{body}\n```"), "Zedge CERA"))
            }
        }
        "mutations" => {
            let body = companion_get("/cera/mutations")?;
            if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(&body) {
                if arr.is_empty() {
                    return Ok(output_with_section(
                        "No pending mutations.".to_string(),
                        "Zedge CERA",
                    ));
                }
                let mut text = "## Pending Mutations\n\n".to_string();
                for m in &arr {
                    let id = m["id"].as_str().unwrap_or("?");
                    let desc = m["mutation"]["description"].as_str().unwrap_or("?");
                    let delta = m["mutation"]["entropyDelta"].as_f64().unwrap_or(0.0);
                    let strategy = m["mutation"]["strategy"].as_str().unwrap_or("?");
                    text.push_str(&format!(
                        "- **{}** ({}): {} [entropy delta: {:.1}]\n",
                        id, strategy, desc, delta
                    ));
                }
                text.push_str("\nUse `/zedge-cera accept <id>` or `/zedge-cera reject <id>`");
                Ok(output_with_section(text, "Zedge CERA"))
            } else {
                Ok(output_with_section(format!("```\n{body}\n```"), "Zedge CERA"))
            }
        }
        "accept" => {
            let id = parts.get(1).unwrap_or(&"");
            if id.is_empty() {
                return Ok(output_with_section(
                    "Usage: `/zedge-cera accept <mutation-id>`".to_string(),
                    "Zedge CERA",
                ));
            }
            let body = companion_post(&format!("/cera/accept/{id}"))?;
            Ok(output_with_section(
                format!("Mutation **{id}** accepted.\n\n```json\n{body}\n```"),
                "Zedge CERA",
            ))
        }
        "reject" => {
            let id = parts.get(1).unwrap_or(&"");
            if id.is_empty() {
                return Ok(output_with_section(
                    "Usage: `/zedge-cera reject <mutation-id>`".to_string(),
                    "Zedge CERA",
                ));
            }
            let body = companion_post(&format!("/cera/reject/{id}"))?;
            Ok(output_with_section(
                format!("Mutation **{id}** rejected (recorded in void map).\n\n```json\n{body}\n```"),
                "Zedge CERA",
            ))
        }
        "history" => {
            let body = companion_get("/cera/history")?;
            if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(&body) {
                if arr.is_empty() {
                    return Ok(output_with_section(
                        "No mutation history yet.".to_string(),
                        "Zedge CERA",
                    ));
                }
                let mut text = "## Mutation History\n\n".to_string();
                for m in arr.iter().take(20) {
                    let id = m["id"].as_str().unwrap_or("?");
                    let status = m["status"].as_str().unwrap_or("?");
                    let desc = m["mutation"]["description"].as_str().unwrap_or("?");
                    let icon = match status {
                        "accepted" => "V",
                        "rejected" => "X",
                        _ => "-",
                    };
                    text.push_str(&format!("- [{}] **{}**: {}\n", icon, id, desc));
                }
                Ok(output_with_section(text, "Zedge CERA"))
            } else {
                Ok(output_with_section(format!("```\n{body}\n```"), "Zedge CERA"))
            }
        }
        "daydream" => {
            let body = companion_get("/cera/daydream/status")?;
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                let dreaming = v["dreaming"].as_bool().unwrap_or(false);
                let total = v["totalDreams"].as_u64().unwrap_or(0);
                let cached = v["cachedCandidates"].as_u64().unwrap_or(0);
                let hits = v["cacheHits"].as_u64().unwrap_or(0);
                let misses = v["cacheMisses"].as_u64().unwrap_or(0);
                let idle_ms = v["idleSinceMs"].as_u64().unwrap_or(0);
                let entropy = v["voidMapEntropy"].as_f64().unwrap_or(0.0);

                let hit_rate = if hits + misses > 0 {
                    format!("{:.0}%", (hits as f64 / (hits + misses) as f64) * 100.0)
                } else {
                    "N/A".to_string()
                };

                let text = format!(
                    "## CERA Daydream Engine\n\n\
                     **State**: {}\n\
                     **Idle**: {}ms | **Total dreams**: {}\n\
                     **Cached candidates**: {} | **Hit rate**: {}\n\
                     **Void map entropy**: {:.3}\n\n\
                     Daydreaming is void walking during idle windows.\n\
                     The engine speculatively explores mutation strategies\n\
                     so the next real alert finds a pre-warmed walker.",
                    if dreaming { "Dreaming" } else { "Awake" },
                    idle_ms, total, cached, hit_rate, entropy
                );
                Ok(output_with_section(text, "Zedge CERA"))
            } else {
                Ok(output_with_section(format!("```\n{body}\n```"), "Zedge CERA"))
            }
        }
        _ => Ok(output_with_section(
            "Unknown subcommand. Available: `status`, `mutations`, `accept <id>`, `reject <id>`, `history`, `daydream`".to_string(),
            "Zedge CERA",
        )),
    }
}

/// /zedge-review — Consensus code review via constructive superinference
///
/// Runs three models in parallel on the current file's git diff. Output shows
/// where models agree (high confidence) and where they disagree (flagged for
/// human review). This is something Cursor cannot do -- honest uncertainty
/// signal from multiple models.
pub fn run_review(worktree: Option<&Worktree>) -> Result<SlashCommandOutput, String> {
    // Get git diff for context
    let diff_context = match worktree {
        Some(wt) => {
            let entries = wt.read_text_file(".git/HEAD");
            if entries.is_ok() {
                match companion_get("/vfs/changes") {
                    Ok(changes) => changes,
                    Err(_) => "(no git changes available)".to_string(),
                }
            } else {
                "(not a git repository)".to_string()
            }
        }
        None => "(no worktree)".to_string(),
    };

    // Run constructive superinference on the diff
    let body = serde_json::json!({
        "messages": [
            {
                "role": "system",
                "content": "You are a code reviewer. Review the following git diff. Be specific about:\n1. Potential bugs or logic errors\n2. Performance concerns\n3. Style/readability improvements\n4. Security considerations\nBe constructive and concise."
            },
            {
                "role": "user",
                "content": format!("Review this diff:\n\n```diff\n{}\n```", diff_context)
            }
        ],
        "strategy": "constructive",
        "timeout_ms": 60000
    });

    match companion_post_json("/v1/superinference", body) {
        Ok(resp_body) => {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&resp_body) {
                let content = value["content"].as_str().unwrap_or("(no review content)");
                let winning_model = value["winningModel"].as_str().unwrap_or("unknown");
                let confidence = value["confidence"].as_f64().unwrap_or(0.0);
                let duration_ms = value["durationMs"].as_u64().unwrap_or(0);
                let strategy = value["strategy"].as_str().unwrap_or("constructive");

                let mut parts = vec![
                    "## Consensus Code Review\n".to_string(),
                    format!("**Strategy**: {} | **Confidence**: {:.0}% | **Duration**: {}ms | **Lead model**: {}\n",
                        strategy, confidence * 100.0, duration_ms, winning_model),
                ];

                // Show per-model results if available
                if let Some(models) = value["modelResults"].as_array() {
                    parts.push("### Per-Model Results\n".to_string());
                    for m in models {
                        let model = m["model"].as_str().unwrap_or("?");
                        let ms = m["durationMs"].as_u64().unwrap_or(0);
                        let finished = m["finished"].as_bool().unwrap_or(false);
                        let status = if finished { "completed" } else { "timed out" };
                        parts.push(format!("- **{}** — {} ({}ms)", model, status, ms));
                    }
                    parts.push(String::new());
                }

                parts.push("### Review\n".to_string());
                parts.push(content.to_string());

                Ok(output_with_section(parts.join("\n"), "Consensus Code Review"))
            } else {
                Ok(output_with_section(format!("```\n{resp_body}\n```"), "Consensus Code Review"))
            }
        }
        Err(e) => Ok(output_with_section(
            format!("**Superinference unavailable**: {e}\n\nEnsure the companion sidecar is running."),
            "Consensus Code Review",
        )),
    }
}

/// /zedge-void — persistent rejection memory and steering vectors
pub fn run_void(args: &[String]) -> Result<SlashCommandOutput, String> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("status");
    let response = match sub {
        "query" => {
            let mut path = "/void-map/query".to_string();
            let mut params: Vec<String> = Vec::new();
            if let Some(file) = args.get(1) {
                params.push(format!("file={}", escape_query_component(file)));
            }
            if let Some(category) = args.get(2) {
                params.push(format!("category={}", escape_query_component(category)));
            }
            if !params.is_empty() {
                path.push('?');
                path.push_str(&params.join("&"));
            }
            companion_get(&path)
        }
        "steering" => {
            let path = if let Some(file) = args.get(1) {
                format!(
                    "/void-map/steering?file={}",
                    escape_query_component(file)
                )
            } else {
                "/void-map/steering".to_string()
            };
            companion_get(&path)
        }
        "export" => {
            let mut path = "/void-map/export/records".to_string();
            let mut params: Vec<String> = Vec::new();
            if let Some(file) = args.get(1) {
                params.push(format!("file={}", escape_query_component(file)));
            }
            if let Some(category) = args.get(2) {
                params.push(format!("category={}", escape_query_component(category)));
            }
            if !params.is_empty() {
                path.push('?');
                path.push_str(&params.join("&"));
            }
            companion_get(&path)
        }
        "compact" => companion_post("/void-map/compact"),
        _ => companion_get("/void-map/status"),
    };

    match response {
        Ok(body) => Ok(output_with_section(
            format!("## Void Map\n\n```json\n{body}\n```"),
            "Void Map",
        )),
        Err(e) => Ok(output_with_section(format!("**Error**: {e}"), "Void Map")),
    }
}

/// /zedge-swarm — list swarm roles or start a swarm run
pub fn run_swarm(args: &[String]) -> Result<SlashCommandOutput, String> {
    if args.is_empty() {
        return match companion_get("/agent/swarm/roles") {
            Ok(body) => Ok(output_with_section(
                format!("## Swarm Roles\n\n```json\n{body}\n```"),
                "Swarm Roles",
            )),
            Err(e) => Ok(output_with_section(format!("**Error**: {e}"), "Swarm Roles")),
        };
    }

    let task = args.join(" ");
    let body = serde_json::json!({
        "task": task,
        "roles": ["reviewer", "refactorer", "tester"]
    });

    match companion_post_json("/agent/swarm/start", body) {
        Ok(resp_body) => Ok(output_with_section(
            format!("## Swarm Started\n\n```json\n{resp_body}\n```"),
            "Swarm",
        )),
        Err(e) => Ok(output_with_section(format!("**Error**: {e}"), "Swarm")),
    }
}

/// /zedge-engram — persistent agent memory
pub fn run_engram(args: &[String]) -> Result<SlashCommandOutput, String> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("status");
    let response = match sub {
        "recall" => {
            let query = args[1..].join(" ");
            if query.is_empty() {
                return Ok(output_with_section(
                    "Usage: /zedge-engram recall <query>".to_string(),
                    "Engram",
                ));
            }
            companion_post_json(
                "/engram/recall",
                serde_json::json!({ "query": query, "top_k": 5 }),
            )
        }
        "remember" => {
            let content = args[1..].join(" ");
            if content.is_empty() {
                return Ok(output_with_section(
                    "Usage: /zedge-engram remember <content>".to_string(),
                    "Engram",
                ));
            }
            companion_post_json(
                "/engram/remember",
                serde_json::json!({ "type": "code-pattern", "content": content }),
            )
        }
        "forget" => {
            let Some(id) = args.get(1) else {
                return Ok(output_with_section(
                    "Usage: /zedge-engram forget <id>".to_string(),
                    "Engram",
                ));
            };
            companion_delete(&format!(
                "/engram/forget?id={}",
                escape_query_component(id)
            ))
        }
        _ => companion_get("/engram/status"),
    };

    match response {
        Ok(body) => Ok(output_with_section(
            format!("## Engram Store\n\n```json\n{body}\n```"),
            "Engram",
        )),
        Err(e) => Ok(output_with_section(format!("**Error**: {e}"), "Engram")),
    }
}

/// /zedge-emotion — emotional profile of a file
pub fn run_emotion(
    args: &[String],
    _worktree: Option<&Worktree>,
) -> Result<SlashCommandOutput, String> {
    let Some(file_path) = args.first() else {
        return Ok(output_with_section(
            "Usage: /zedge-emotion <file-path>".to_string(),
            "Emotion",
        ));
    };

    match companion_get(&format!(
        "/emotion/profile?file={}",
        escape_query_component(file_path)
    )) {
        Ok(body) => Ok(output_with_section(
            format!("## Emotional Profile\n\n```json\n{body}\n```"),
            "Emotion",
        )),
        Err(e) => Ok(output_with_section(format!("**Error**: {e}"), "Emotion")),
    }
}

/// /zedge-agent — GG agent management over Forge
pub fn run_agent(args: &[String]) -> Result<SlashCommandOutput, String> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("list");
    let response = match sub {
        "trigger" => {
            let Some(agent_name) = args.get(1) else {
                return Ok(output_with_section(
                    "Usage: /zedge-agent trigger <agent-name>".to_string(),
                    "GG Agent",
                ));
            };
            companion_post_json(
                "/forge/deploy",
                serde_json::json!({ "project": agent_name, "trigger": "manual" }),
            )
        }
        "status" => companion_get("/forge/status"),
        "health" => {
            let Some(agent_name) = args.get(1) else {
                return Ok(output_with_section(
                    "Usage: /zedge-agent health <agent-name>".to_string(),
                    "GG Agent",
                ));
            };
            companion_get(&format!(
                "/forge/status?project={}",
                escape_query_component(agent_name)
            ))
        }
        _ => companion_get("/forge/projects"),
    };

    match response {
        Ok(body) => Ok(output_with_section(
            format!("## GG Agents\n\n```json\n{body}\n```"),
            "GG Agent",
        )),
        Err(e) => Ok(output_with_section(format!("**Error**: {e}"), "GG Agent")),
    }
}
