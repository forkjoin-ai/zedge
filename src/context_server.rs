/// Zedge Context Server (v0.7 API)
///
/// In v0.7, Zed natively supports context servers via the Extension trait's
/// `context_server_command` and `context_server_configuration` methods.
///
/// The companion sidecar at localhost:7331 serves as the context server,
/// providing workspace context through its ACP agent, VFS, and inference
/// endpoints. The context server is registered in extension.toml and
/// configured via `context_server_configuration` in lib.rs.
///
/// This module provides utility functions for enriching inference prompts
/// with workspace context fetched from the companion.
use zed_extension_api::http_client::*;

use crate::provider;

/// Fetch workspace context summary from the companion's VFS
pub fn fetch_workspace_summary() -> Result<String, String> {
    let url = format!("{}/vfs/tree", provider::COMPANION_URL);
    let response = HttpRequest::builder()
        .method(HttpMethod::Get)
        .url(&url)
        .redirect_policy(RedirectPolicy::FollowAll)
        .build()?
        .fetch()
        .map_err(|e| format!("VFS unavailable: {e}"))?;

    let body = String::from_utf8(response.body).map_err(|e| format!("Invalid UTF-8: {e}"))?;

    Ok(body)
}

/// Fetch git diff from the companion's VFS
pub fn fetch_git_diff() -> Result<String, String> {
    let url = format!("{}/vfs/changes", provider::COMPANION_URL);
    let response = HttpRequest::builder()
        .method(HttpMethod::Get)
        .url(&url)
        .redirect_policy(RedirectPolicy::FollowAll)
        .build()?
        .fetch()
        .map_err(|e| format!("VFS unavailable: {e}"))?;

    let body = String::from_utf8(response.body).map_err(|e| format!("Invalid UTF-8: {e}"))?;

    Ok(body)
}

/// Build a system prompt enrichment from workspace context
pub fn build_context_prompt(file_tree: Option<&str>, git_diff: Option<&str>) -> String {
    let mut parts = Vec::new();

    if let Some(tree) = file_tree {
        if !tree.is_empty() {
            parts.push(format!("<file_tree>\n{tree}\n</file_tree>"));
        }
    }

    if let Some(diff) = git_diff {
        if !diff.is_empty() {
            parts.push(format!("<git_diff>\n{diff}\n</git_diff>"));
        }
    }

    if parts.is_empty() {
        return String::new();
    }

    format!(
        "The following workspace context is available:\n\n{}",
        parts.join("\n\n")
    )
}
