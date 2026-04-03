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

/// Available models — all Edgework edge models via Glossolalia MOA.
/// IDs match what edge.affectively.ai/v1/models returns.
pub const MODELS: &[ZedgeModel] = &[
    // ── Primary coding models ──
    ZedgeModel {
        id: "qwen-2.5-coder-7b",
        display_name: "Qwen 2.5 Coder 7B",
        max_tokens: 4096,
    },
    ZedgeModel {
        id: "mistral-7b",
        display_name: "Mistral 7B",
        max_tokens: 4096,
    },
    ZedgeModel {
        id: "deepseek-r1-7b",
        display_name: "DeepSeek R1 7B",
        max_tokens: 4096,
    },
    // ── Reasoning / large ──
    ZedgeModel {
        id: "llama-70b",
        display_name: "LLaMA 2 70B",
        max_tokens: 4096,
    },
    ZedgeModel {
        id: "glm-4-9b",
        display_name: "GLM-4 9B",
        max_tokens: 4096,
    },
    ZedgeModel {
        id: "step-3.5-flash",
        display_name: "Step 3.5 Flash",
        max_tokens: 4096,
    },
    // ── Mid-size ──
    ZedgeModel {
        id: "gemma3-4b-it",
        display_name: "Gemma 3 4B IT",
        max_tokens: 4096,
    },
    ZedgeModel {
        id: "nanbeige-3b",
        display_name: "Nanbeige 3B",
        max_tokens: 4096,
    },
    ZedgeModel {
        id: "mamba-2.8b",
        display_name: "Mamba 2.8B",
        max_tokens: 4096,
    },
    // ── Small / fast ──
    ZedgeModel {
        id: "gemma3-1b-it",
        display_name: "Gemma 3 1B IT",
        max_tokens: 2048,
    },
    ZedgeModel {
        id: "deepseek-r1-1.5b",
        display_name: "DeepSeek R1 1.5B",
        max_tokens: 2048,
    },
    ZedgeModel {
        id: "tinyllama-1.1b",
        display_name: "TinyLlama 1.1B (Fast)",
        max_tokens: 2048,
    },
    // ── Edgework internal ──
    ZedgeModel {
        id: "smollm2-360m",
        display_name: "SmolLM2 360M",
        max_tokens: 1024,
    },
    ZedgeModel {
        id: "cog-360m",
        display_name: "Cog 360M",
        max_tokens: 1024,
    },
    ZedgeModel {
        id: "cyrano-360m",
        display_name: "Cyrano 360M",
        max_tokens: 1024,
    },
];
