import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getZedgeConfig } from './config.ts';
import {
  analyzePolyglotSourceString,
  type PolyglotAnalysisResult,
} from './babelfish-gnosis.ts';
import { extractFunctions, translate } from './babelfish-gnosis.ts';
import {
  getPolyglotCapabilityMatrix,
  type PolyglotCapabilityMatrix,
  type PolyglotCapabilityStatus,
} from './babelfish-gnosis.ts';

export type BabelfishCodeMode =
  | 'translate-code'
  | 'generate'
  | 'rewrite-preview';
export type BabelfishCodeOutputMode =
  | 'preview'
  | 'generate_files'
  | 'rewrite_in_place_requested';
export type BabelfishApplyMode = 'generate_files' | 'rewrite_in_place';

export interface BabelfishScopeDiagnostic {
  message: string;
  severity?: 'error' | 'warning' | 'info' | 'hint';
  source?: string;
}

export interface BabelfishScope {
  kind?: 'inline' | 'file';
  filePath?: string;
  sourceText?: string;
  selectionText?: string;
  diagnostics?: BabelfishScopeDiagnostic[];
}

export interface BabelfishGeneratedFile {
  fileName: string;
  filePath: string;
  language: string;
  content: string;
}

export interface BabelfishCodePreviewRequest {
  scope: BabelfishScope;
  sourceLanguage?: string;
  targetLanguage: string;
  mode: BabelfishCodeMode;
  outputMode: BabelfishCodeOutputMode;
}

export interface BabelfishCodePreviewResponse {
  previewId: string;
  summary: string;
  confidence: number;
  warnings: string[];
  ggSource?: string;
  generatedFiles: BabelfishGeneratedFile[];
  diff?: string;
}

export interface BabelfishCodeApplyRequest {
  previewId: string;
  applyMode: BabelfishApplyMode;
}

export interface BabelfishCodeApplyResponse {
  writtenFiles: string[];
  patchedFile?: string;
  appliedPreviewId: string;
}

export interface BabelfishTextTranslateRequest {
  scope: BabelfishScope;
  targetHumanLanguage: string;
  includeComments?: boolean;
  includeDiagnostics?: boolean;
  includeMarkdown?: boolean;
}

export interface BabelfishTextTranslateResponse {
  sourceLanguage: string;
  targetLanguage: string;
  translatedText: string;
  translatedDiagnostics: BabelfishScopeDiagnostic[];
  warnings: string[];
}

export interface BabelfishExplainRequest {
  scope: BabelfishScope;
  audienceLanguage: string;
  includeGg?: boolean;
}

export interface BabelfishExplainResponse {
  sourceLanguage: string;
  audienceLanguage: string;
  summary: string;
  explanation: string;
  ggSource?: string;
  warnings: string[];
}

export interface BabelfishHumanLanguage {
  code: string;
  name: string;
  status: PolyglotCapabilityStatus;
}

export interface BabelfishCapabilitiesResponse {
  registrySource: string;
  languages: PolyglotCapabilityMatrix['languages'];
  humanLanguages: BabelfishHumanLanguage[];
  outputModes: BabelfishCodeOutputMode[];
}

interface ResolvedBabelfishScope {
  filePath: string;
  sourceText: string;
  diagnostics: BabelfishScopeDiagnostic[];
}

interface BabelfishStoredPreview {
  previewId: string;
  sourceFilePath: string;
  originalContent: string;
  generatedFiles: BabelfishGeneratedFile[];
  allowedApplyModes: BabelfishApplyMode[];
}

const workspaceRoot = process.env.AEON_ROOT || process.cwd();

const previewStore = new Map<string, BabelfishStoredPreview>();

const HUMAN_LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  ja: 'Japanese',
  zh: 'Chinese',
};

const HUMAN_TRANSLATIONS: Record<
  string,
  Record<string, Record<string, string>>
> = {
  en: {
    es: {
      babelfish: 'babelpez',
      code: 'código',
      comment: 'comentario',
      comments: 'comentarios',
      diagnostics: 'diagnósticos',
      error: 'error',
      errors: 'errores',
      explain: 'explicar',
      explanation: 'explicación',
      file: 'archivo',
      files: 'archivos',
      function: 'función',
      functions: 'funciones',
      hello: 'hola',
      language: 'idioma',
      languages: 'idiomas',
      preview: 'vista previa',
      summary: 'resumen',
      text: 'texto',
      translate: 'traducir',
      translation: 'traducción',
      warning: 'advertencia',
      warnings: 'advertencias',
      world: 'mundo',
    },
    fr: {
      code: 'code',
      comment: 'commentaire',
      comments: 'commentaires',
      diagnostics: 'diagnostics',
      error: 'erreur',
      errors: 'erreurs',
      explain: 'expliquer',
      explanation: 'explication',
      file: 'fichier',
      files: 'fichiers',
      function: 'fonction',
      functions: 'fonctions',
      hello: 'bonjour',
      language: 'langue',
      languages: 'langues',
      preview: 'aperçu',
      summary: 'résumé',
      text: 'texte',
      translate: 'traduire',
      translation: 'traduction',
      warning: 'avertissement',
      warnings: 'avertissements',
      world: 'monde',
    },
    de: {
      code: 'code',
      comment: 'kommentar',
      comments: 'kommentare',
      diagnostics: 'diagnosen',
      error: 'fehler',
      errors: 'fehler',
      explain: 'erklären',
      explanation: 'erklärung',
      file: 'datei',
      files: 'dateien',
      function: 'funktion',
      functions: 'funktionen',
      hello: 'hallo',
      language: 'sprache',
      languages: 'sprachen',
      preview: 'vorschau',
      summary: 'zusammenfassung',
      text: 'text',
      translate: 'übersetzen',
      translation: 'übersetzung',
      warning: 'warnung',
      warnings: 'warnungen',
      world: 'welt',
    },
    ja: {
      code: 'コード',
      comment: 'コメント',
      comments: 'コメント',
      diagnostics: '診断',
      error: 'エラー',
      errors: 'エラー',
      explain: '説明',
      explanation: '説明',
      file: 'ファイル',
      files: 'ファイル',
      function: '関数',
      functions: '関数',
      hello: 'こんにちは',
      language: '言語',
      languages: '言語',
      preview: 'プレビュー',
      summary: '要約',
      text: 'テキスト',
      translate: '翻訳',
      translation: '翻訳',
      warning: '警告',
      warnings: '警告',
      world: '世界',
    },
    zh: {
      code: '代码',
      comment: '注释',
      comments: '注释',
      diagnostics: '诊断',
      error: '错误',
      errors: '错误',
      explain: '解释',
      explanation: '解释',
      file: '文件',
      files: '文件',
      function: '函数',
      functions: '函数',
      hello: '你好',
      language: '语言',
      languages: '语言',
      preview: '预览',
      summary: '摘要',
      text: '文本',
      translate: '翻译',
      translation: '翻译',
      warning: '警告',
      warnings: '警告',
      world: '世界',
    },
  },
};

function ensureBabelfishEnabled(): void {
  if (!getZedgeConfig().babelfish.enabled) {
    throw new Error('Babelfish is disabled in companion settings');
  }
}

function normalizeFilePath(filePath: string | undefined): string {
  if (!filePath || filePath.trim().length === 0) {
    return path.join(workspaceRoot, 'inline.ts');
  }
  return path.isAbsolute(filePath)
    ? filePath
    : path.join(workspaceRoot, filePath);
}

async function resolveScope(
  scope: BabelfishScope
): Promise<ResolvedBabelfishScope> {
  const filePath = normalizeFilePath(scope.filePath);
  if (typeof scope.sourceText === 'string') {
    return {
      filePath,
      sourceText: scope.selectionText ?? scope.sourceText,
      diagnostics: scope.diagnostics ?? [],
    };
  }

  const sourceText = await readFile(filePath, 'utf8');
  return {
    filePath,
    sourceText: scope.selectionText ?? sourceText,
    diagnostics: scope.diagnostics ?? [],
  };
}

function buildPreviewDiff(
  sourceFilePath: string,
  originalContent: string,
  nextContent: string
): string | undefined {
  if (originalContent === nextContent) {
    return undefined;
  }

  const before = originalContent.split('\n');
  const after = nextContent.split('\n');
  const max = Math.max(before.length, after.length);
  const lines = [`--- ${sourceFilePath}`, `+++ ${sourceFilePath}`];

  for (let index = 0; index < max; index++) {
    const oldLine = before[index];
    const newLine = after[index];
    if (oldLine === newLine) {
      if (oldLine !== undefined) {
        lines.push(` ${oldLine}`);
      }
      continue;
    }
    if (oldLine !== undefined) {
      lines.push(`-${oldLine}`);
    }
    if (newLine !== undefined) {
      lines.push(`+${newLine}`);
    }
  }

  return lines.join('\n');
}

function titleCase(value: string): string {
  return value
    .split(/[_-\s]+/)
    .map((segment) =>
      segment.length > 0
        ? segment.charAt(0).toUpperCase() + segment.slice(1)
        : segment
    )
    .join(' ');
}

function translateWord(token: string, targetLanguage: string): string {
  const sourceDictionary = HUMAN_TRANSLATIONS.en[targetLanguage];
  if (!sourceDictionary) {
    return token;
  }

  const lower = token.toLowerCase();
  const translated = sourceDictionary[lower];
  if (!translated) {
    return token;
  }

  if (token === token.toUpperCase()) {
    return translated.toUpperCase();
  }
  if (token[0] === token[0].toUpperCase()) {
    return translated.charAt(0).toUpperCase() + translated.slice(1);
  }
  return translated;
}

function translatePlainText(text: string, targetLanguage: string): string {
  if (targetLanguage === 'en' || !HUMAN_LANGUAGE_NAMES[targetLanguage]) {
    return text;
  }

  return text.replace(/\b[\p{L}][\p{L}\p{N}_-]*\b/gu, (token) =>
    translateWord(token, targetLanguage)
  );
}

function translateMarkdownPreservingCode(
  text: string,
  targetLanguage: string
): string {
  const segments = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return segments
    .map((segment) => {
      if (segment.startsWith('```') || segment.startsWith('`')) {
        return segment;
      }
      return translatePlainText(segment, targetLanguage);
    })
    .join('');
}

function translateCommentsInSource(
  text: string,
  targetLanguage: string,
  includeMarkdown: boolean
): string {
  let translated = text.replace(
    /(\/\/\s*)([^\n]*)/g,
    (_match, prefix: string, body: string) =>
      `${prefix}${
        includeMarkdown
          ? translateMarkdownPreservingCode(body, targetLanguage)
          : translatePlainText(body, targetLanguage)
      }`
  );

  translated = translated.replace(
    /(^|\n)(\s*#\s*)([^\n]*)/g,
    (_match, newline: string, prefix: string, body: string) =>
      `${newline}${prefix}${
        includeMarkdown
          ? translateMarkdownPreservingCode(body, targetLanguage)
          : translatePlainText(body, targetLanguage)
      }`
  );

  return translated.replace(
    /\/\*([\s\S]*?)\*\//g,
    (_match, body: string) =>
      `/*${
        includeMarkdown
          ? translateMarkdownPreservingCode(body, targetLanguage)
          : translatePlainText(body, targetLanguage)
      }*/`
  );
}

function confidenceForStatus(status: PolyglotCapabilityStatus): number {
  switch (status) {
    case 'supported':
      return 0.82;
    case 'experimental':
      return 0.61;
    default:
      return 0.3;
  }
}

async function analyzeScope(
  resolvedScope: ResolvedBabelfishScope
): Promise<PolyglotAnalysisResult> {
  return analyzePolyglotSourceString(
    resolvedScope.sourceText,
    resolvedScope.filePath
  );
}

function humanLanguages(): BabelfishHumanLanguage[] {
  return Object.entries(HUMAN_LANGUAGE_NAMES).map(([code, name]) => ({
    code,
    name,
    status: code === 'en' ? 'supported' : 'experimental',
  }));
}

export async function getBabelfishCapabilities(): Promise<BabelfishCapabilitiesResponse> {
  ensureBabelfishEnabled();
  const matrix = await getPolyglotCapabilityMatrix();
  return {
    registrySource: matrix.registrySource,
    languages: matrix.languages,
    humanLanguages: humanLanguages(),
    outputModes: ['preview', 'generate_files', 'rewrite_in_place_requested'],
  };
}

async function buildGeneratedFiles(
  sourceFilePath: string,
  targetLanguage: string,
  analysis: PolyglotAnalysisResult
): Promise<{ generatedFiles: BabelfishGeneratedFile[]; ggSource: string }> {
  const translated = translate(analysis, sourceFilePath, targetLanguage);
  const baseDir = path.dirname(sourceFilePath);

  return {
    ggSource: translated.ggSource,
    generatedFiles: translated.files.map((file) => ({
      fileName: file.fileName,
      filePath: path.join(baseDir, file.fileName),
      language: targetLanguage,
      content: file.source,
    })),
  };
}

async function writeGeneratedFiles(
  files: BabelfishGeneratedFile[]
): Promise<string[]> {
  const writtenFiles: string[] = [];
  for (const file of files) {
    await mkdir(path.dirname(file.filePath), { recursive: true });
    await writeFile(file.filePath, file.content, 'utf8');
    writtenFiles.push(file.filePath);
  }
  return writtenFiles;
}

export async function previewBabelfishCode(
  request: BabelfishCodePreviewRequest
): Promise<BabelfishCodePreviewResponse> {
  ensureBabelfishEnabled();
  const capabilities = await getPolyglotCapabilityMatrix();
  const capability = capabilities.languages.find(
    (language) => language.id === request.targetLanguage
  );
  if (!capability) {
    throw new Error(`Unsupported target language: ${request.targetLanguage}`);
  }

  const operationStatus =
    request.mode === 'rewrite-preview'
      ? capability.operations.rewritePreview
      : capability.operations.translate;
  if (operationStatus === 'unsupported') {
    throw new Error(
      `${titleCase(request.mode)} is unsupported for ${request.targetLanguage}`
    );
  }

  const resolvedScope = await resolveScope(request.scope);
  const analysis = await analyzeScope(resolvedScope);
  const generated = await buildGeneratedFiles(
    resolvedScope.filePath,
    request.targetLanguage,
    analysis
  );
  const previewId = randomUUID();
  const warnings = [...analysis.errors];
  const allowedApplyModes: BabelfishApplyMode[] =
    request.outputMode === 'rewrite_in_place_requested'
      ? ['rewrite_in_place']
      : request.outputMode === 'preview'
      ? ['generate_files']
      : [];

  if (request.outputMode === 'rewrite_in_place_requested') {
    warnings.push(
      'In-place rewrite remains experimental and will replace the current file contents on apply.'
    );
  }

  if (request.outputMode === 'generate_files') {
    warnings.push(
      'Files were written immediately; this preview token is informational only and cannot be applied again.'
    );
  }

  if (
    request.mode === 'rewrite-preview' &&
    analysis.language !== request.targetLanguage
  ) {
    warnings.push(
      'Rewrite preview is cross-language; applying it will keep the existing file path while replacing contents.'
    );
  }

  if (request.outputMode === 'generate_files') {
    await writeGeneratedFiles(generated.generatedFiles);
  }

  previewStore.set(previewId, {
    previewId,
    sourceFilePath: resolvedScope.filePath,
    originalContent: resolvedScope.sourceText,
    generatedFiles: generated.generatedFiles,
    allowedApplyModes,
  });

  const primaryGeneratedFile = generated.generatedFiles[0];
  return {
    previewId,
    summary:
      request.outputMode === 'generate_files'
        ? `Generated ${generated.generatedFiles.length} ${request.targetLanguage} file(s) from ${analysis.language}.`
        : request.outputMode === 'rewrite_in_place_requested'
        ? `Prepared in-place rewrite preview for ${path.basename(
            resolvedScope.filePath
          )} from ${analysis.language} to ${
            request.targetLanguage
          }. Apply is required before any file mutation.`
        : `Prepared ${request.mode} preview for ${path.basename(
            resolvedScope.filePath
          )} from ${analysis.language} to ${request.targetLanguage}.`,
    confidence: confidenceForStatus(operationStatus),
    warnings,
    ggSource: generated.ggSource || undefined,
    generatedFiles: generated.generatedFiles,
    diff: primaryGeneratedFile
      ? buildPreviewDiff(
          resolvedScope.filePath,
          resolvedScope.sourceText,
          primaryGeneratedFile.content
        )
      : undefined,
  };
}

export async function applyBabelfishCodePreview(
  request: BabelfishCodeApplyRequest
): Promise<BabelfishCodeApplyResponse> {
  ensureBabelfishEnabled();
  const preview = previewStore.get(request.previewId);
  if (!preview) {
    throw new Error(`Unknown previewId: ${request.previewId}`);
  }

  if (preview.allowedApplyModes.length === 0) {
    throw new Error(
      `Preview ${request.previewId} is already finalized and cannot be applied again`
    );
  }

  if (!preview.allowedApplyModes.includes(request.applyMode)) {
    throw new Error(
      `Preview ${
        request.previewId
      } only supports apply modes: ${preview.allowedApplyModes.join(', ')}`
    );
  }

  let writtenFiles: string[] = [];
  let patchedFile: string | undefined;

  if (request.applyMode === 'rewrite_in_place') {
    if (preview.generatedFiles.length === 0) {
      throw new Error('Preview has no generated files to apply');
    }

    const replacement = preview.generatedFiles[0];
    await writeFile(preview.sourceFilePath, replacement.content, 'utf8');
    writtenFiles = [preview.sourceFilePath];
    patchedFile = preview.sourceFilePath;
  } else {
    writtenFiles = await writeGeneratedFiles(preview.generatedFiles);
  }

  previewStore.delete(request.previewId);
  return {
    writtenFiles,
    patchedFile,
    appliedPreviewId: request.previewId,
  };
}

export async function translateBabelfishText(
  request: BabelfishTextTranslateRequest
): Promise<BabelfishTextTranslateResponse> {
  ensureBabelfishEnabled();
  const resolvedScope = await resolveScope(request.scope);
  const warnings: string[] = [];
  const targetLanguage = request.targetHumanLanguage;

  if (!HUMAN_LANGUAGE_NAMES[targetLanguage]) {
    warnings.push(
      `No local Babelfish translator is available for ${targetLanguage}; returning source text unchanged.`
    );
  }

  let translatedText = resolvedScope.sourceText;
  if (request.includeComments) {
    translatedText = translateCommentsInSource(
      resolvedScope.sourceText,
      targetLanguage,
      request.includeMarkdown ?? false
    );
  } else if (request.includeMarkdown) {
    translatedText = translateMarkdownPreservingCode(
      resolvedScope.sourceText,
      targetLanguage
    );
  } else {
    translatedText = translatePlainText(
      resolvedScope.sourceText,
      targetLanguage
    );
  }

  const translatedDiagnostics =
    request.includeDiagnostics === false
      ? []
      : resolvedScope.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          message:
            request.includeMarkdown ?? false
              ? translateMarkdownPreservingCode(
                  diagnostic.message,
                  targetLanguage
                )
              : translatePlainText(diagnostic.message, targetLanguage),
        }));

  return {
    sourceLanguage: 'en',
    targetLanguage,
    translatedText,
    translatedDiagnostics,
    warnings,
  };
}

export async function explainBabelfishScope(
  request: BabelfishExplainRequest
): Promise<BabelfishExplainResponse> {
  ensureBabelfishEnabled();
  const resolvedScope = await resolveScope(request.scope);
  const analysis = await analyzeScope(resolvedScope);
  const functions = extractFunctions(analysis, resolvedScope.filePath);
  const warnings = [...analysis.errors];

  const lines = [
    `Detected language: ${titleCase(analysis.language)}.`,
    `Functions: ${functions.length}.`,
  ];

  if (functions.length > 0) {
    const functionSummary = functions
      .map(
        (func) =>
          `${func.name} (${func.nodeCount} nodes, ${
            func.edgeTypes.length > 0 ? func.edgeTypes.join(', ') : 'no edges'
          })`
      )
      .join('; ');
    lines.push(`Topology summary: ${functionSummary}.`);
  }

  if (analysis.errors.length > 0) {
    lines.push(`Analysis warnings: ${analysis.errors.join('; ')}.`);
  }

  const summary = `${path.basename(resolvedScope.filePath)} maps to ${
    functions.length
  } extracted function(s).`;
  const englishExplanation = lines.join(' ');
  const explanation =
    request.audienceLanguage === 'en'
      ? englishExplanation
      : translatePlainText(englishExplanation, request.audienceLanguage);

  if (
    request.audienceLanguage !== 'en' &&
    !HUMAN_LANGUAGE_NAMES[request.audienceLanguage]
  ) {
    warnings.push(
      `No local translator is available for ${request.audienceLanguage}; explanation remains in English.`
    );
  }

  return {
    sourceLanguage: analysis.language,
    audienceLanguage: request.audienceLanguage,
    summary,
    explanation,
    ggSource: request.includeGg
      ? analysis.functions.map((func) => func.ggSource).join('\n\n')
      : undefined,
    warnings,
  };
}

export function resetBabelfishStateForTest(): void {
  previewStore.clear();
}
