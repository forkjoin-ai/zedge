/// Zedge Language Model Provider
///
/// Registers "Zedge" as a language model provider in Zed's AI assistant panel.
/// Proxies inference requests to the companion sidecar at 127.0.0.1:7331.
///
/// Note: Zed's OpenAI-compatible provider in settings.json is the primary
/// integration path. This provider module enables deeper integration when
/// the extension is installed, such as custom model metadata and tier info.

/// Default companion sidecar URL (IPv4 — `localhost` can resolve to ::1 while the listener is IPv4-only)
pub const COMPANION_URL: &str = "http://127.0.0.1:7331";

/// Models exposed by the Zedge provider
pub struct ZedgeModel {
    pub id: &'static str,
    pub display_name: &'static str,
    pub max_tokens: u32,
}

/// Built-in fallback models for the Moonshine OpenAI-compatible agent container.
/// The companion syncs Zed's picker from the live `/v1/models` response when
/// the container is running, so this list is only the offline fallback surface.
pub const MODELS: &[ZedgeModel] = &[
    ZedgeModel {
        id: "gnosis-local",
        display_name: "Gnosis Local (Moonshine)",
        max_tokens: 4096,
    },
    ZedgeModel {
        id: "tinyllama-1.1b",
        display_name: "TinyLlama 1.1B (Moonshine)",
        max_tokens: 2048,
    },
];

pub fn visible_models() -> Vec<&'static ZedgeModel> {
    MODELS.iter().collect()
}
