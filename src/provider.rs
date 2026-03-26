/// Zedge Language Model Provider
///
/// Registers "Zedge" as a language model provider in Zed's AI assistant panel.
/// Proxies inference requests to the companion sidecar at localhost:7331.
///
/// Note: Zed's OpenAI-compatible provider in settings.json is the primary
/// integration path. This provider module enables deeper integration when
/// the extension is installed, such as custom model metadata and tier info.

/// Default companion sidecar URL
pub const COMPANION_URL: &str = "http://localhost:7331";

/// Models exposed by the Zedge provider
pub struct ZedgeModel {
    pub id: &'static str,
    pub display_name: &'static str,
    pub max_tokens: u32,
}

/// Available models — real 7B+ models via edge coordinators
pub const MODELS: &[ZedgeModel] = &[
    ZedgeModel {
        id: "mistral-7b",
        display_name: "Mistral 7B",
        max_tokens: 4096,
    },
    ZedgeModel {
        id: "qwen-2.5-coder-7b",
        display_name: "Qwen 2.5 Coder 7B",
        max_tokens: 4096,
    },
    ZedgeModel {
        id: "deepseek-r1-distill-qwen-7b",
        display_name: "DeepSeek R1 7B",
        max_tokens: 4096,
    },
    ZedgeModel {
        id: "tinyllama-1.1b",
        display_name: "TinyLlama 1.1B (Fast)",
        max_tokens: 2048,
    },
    ZedgeModel {
        id: "gemma3-4b-it",
        display_name: "Gemma3 4B IT",
        max_tokens: 4096,
    },
    ZedgeModel {
        id: "gemma3-1b-it",
        display_name: "Gemma3 1B IT",
        max_tokens: 2048,
    },
    ZedgeModel {
        id: "glm-4-9b",
        display_name: "GLM-4 9B",
        max_tokens: 4096,
    },
    ZedgeModel {
        id: "deepseek-r1",
        display_name: "DeepSeek R1",
        max_tokens: 4096,
    },
    ZedgeModel {
        id: "personaplex-7b",
        display_name: "PersonaPlex 7B (Moshi)",
        max_tokens: 4096,
    },
    ZedgeModel {
        id: "lfm2.5-1.2b-glm-4.7-flash-thinking",
        display_name: "LFM 2.5 1.2B (Thinking)",
        max_tokens: 2048,
    },
];
