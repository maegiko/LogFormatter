/**
 * Parse a complete log file into structured entries.
 *
 * @param {string} rawText - The full log file contents.
 * @param {{ mergeContinuationBlocks?: boolean, includeBlankLines?: boolean }} [options={}] - Parser options.
 * @returns {Array<object>} Parsed log entries.
 */
function parseLogFile(rawText, options = {}) {
  const config = {
    mergeContinuationBlocks: options.mergeContinuationBlocks !== false,
    includeBlankLines: options.includeBlankLines === true,
  };
  const lines = String(rawText ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const entries = [];
  let index = 0;

  while (index < lines.length) {
    const parsed = parseLogEntry(lines, index, config);
    index = parsed.nextIndex;

    if (!config.includeBlankLines && parsed.entry.type === "blank") {
      continue;
    }

    entries.push(parsed.entry);
  }

  return entries;
}

/**
 * Parse a single entry starting at a given line index.
 *
 * @param {string[]} lines - All log lines.
 * @param {number} startIndex - Zero-based line index to begin parsing from.
 * @param {{ mergeContinuationBlocks?: boolean, includeBlankLines?: boolean }} [config={}] - Active parser config.
 * @returns {{ nextIndex: number, entry: object }} The parsed entry and the next unread line index.
 */
function parseLogEntry(lines, startIndex, config = {}) {
  const line = lines[startIndex] ?? "";

  if (line.trim() === "") {
    return {
      nextIndex: startIndex + 1,
      entry: { type: "blank", category: "separator", raw: line },
    };
  }

  const structuredBlock = parseStructuredBlock(lines, startIndex, config);
  if (structuredBlock) {
    return structuredBlock;
  }

  return parseLooseBlock(lines, startIndex, config);
}

/**
 * Parse a structured Minecraft-style log block, including continuation lines.
 *
 * @param {string[]} lines - All log lines.
 * @param {number} startIndex - Zero-based line index to begin parsing from.
 * @param {{ mergeContinuationBlocks?: boolean }} config - Active parser config.
 * @returns {{ nextIndex: number, entry: object } | null} Parsed block result, or `null` if the line is not structured.
 */
function parseStructuredBlock(lines, startIndex, config) {
  const header = parseStructuredLine(lines[startIndex], startIndex);
  if (!header) {
    return null;
  }

  let nextIndex = startIndex + 1;
  const continuation = [];

  if (isModListHeader(header.message)) {
    while (nextIndex < lines.length && isModListItem(lines[nextIndex])) {
      continuation.push(lines[nextIndex]);
      nextIndex += 1;
    }
  }

  if (config.mergeContinuationBlocks) {
    while (
      nextIndex < lines.length &&
      isContinuationLine(lines[nextIndex], header)
    ) {
      continuation.push(lines[nextIndex]);
      nextIndex += 1;
    }
  }

  return {
    nextIndex,
    entry: buildStructuredEntry(
      header,
      continuation,
      lines,
      startIndex,
      nextIndex,
    ),
  };
}

/**
 * Parse a non-structured block such as Gradle/tooling output.
 *
 * @param {string[]} lines - All log lines.
 * @param {number} startIndex - Zero-based line index to begin parsing from.
 * @param {{ mergeContinuationBlocks?: boolean }} config - Active parser config.
 * @returns {{ nextIndex: number, entry: object }} Parsed block result.
 */
function parseLooseBlock(lines, startIndex, config) {
  const firstLine = lines[startIndex];
  let nextIndex = startIndex + 1;
  const blockLines = [firstLine];

  if (config.mergeContinuationBlocks && isLooseBlockHeader(firstLine)) {
    while (nextIndex < lines.length) {
      const nextLine = lines[nextIndex];
      if (nextLine.trim() === "" || parseStructuredLine(nextLine, nextIndex)) {
        break;
      }

      if (!isLooseContinuationLine(nextLine)) {
        break;
      }

      blockLines.push(nextLine);
      nextIndex += 1;
    }
  }

  return {
    nextIndex,
    entry: buildLooseEntry(blockLines, startIndex),
  };
}

/**
 * Parse a single structured runtime line into its component fields.
 *
 * @param {string} line - Raw log line.
 * @param {number} lineNumber - Zero-based source line number.
 * @returns {{ lineNumber: number, raw: string, timestamp: string, thread: string | null, level: string, logger: string | null, message: string } | null} Parsed header data, or `null` if the line does not match a supported structured format.
 */
function parseStructuredLine(line, lineNumber) {
  const patterns = [
    /^\[(?<time>\d{2}:\d{2}:\d{2})\] \[(?<thread>[^\]/]+(?:[^\]]*))\/(?<level>TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\] \((?<logger>[^)]+)\) (?<message>.*)$/,
    /^\[(?<time>\d{2}:\d{2}:\d{2})\] \[(?<thread>[^\]/]+(?:[^\]]*))\/(?<level>TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\] (?<message>.*)$/,
    /^\[(?<time>\d{2}:\d{2}:\d{2})\] \[(?<level>TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\] \[(?<thread>[^\]]+)\] (?<message>.*)$/,
    /^\[(?<thread>[^\]/]+(?:[^\]]*))\/(?<level>TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\] \[(?<logger>[^\]]+)\]: (?<message>.*)$/i,
    /^\[(?<thread>[^\]/]+(?:[^\]]*))\/(?<level>TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\] (?<message>.*)$/i,
    /^\[(?<thread>[^\]]+)\] \[(?<logger>[^\]]+)\]: (?<message>.*)$/i,
  ];

  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (!match) {
      continue;
    }

    const groups = match.groups;
    return {
      lineNumber,
      raw: line,
      timestamp: groups.time || null,
      thread: groups.thread || null,
      level: groups.level ? groups.level.toUpperCase() : "INFO",
      logger: groups.logger || null,
      message: groups.message || "",
    };
  }

  return null;
}

/**
 * Build a final structured entry object from a parsed header and continuation lines.
 *
 * @param {{ lineNumber: number, raw: string, timestamp: string, thread: string | null, level: string, logger: string | null, message: string }} header - Parsed structured line data.
 * @param {string[]} continuationLines - Lines that belong to the same logical block.
 * @param {string[]} allLines - Full source line array.
 * @param {number} startIndex - Zero-based starting index for the block.
 * @param {number} nextIndex - Zero-based index of the next unread line.
 * @returns {object} Final structured log entry.
 */
function buildStructuredEntry(
  header,
  continuationLines,
  allLines,
  startIndex,
  nextIndex,
) {
  const blockLines = [header.raw, ...continuationLines];
  const messageAnalysis = analyzeMessage(header.message, {
    level: header.level,
    logger: header.logger,
    thread: header.thread,
  });
  const details = extractDetails(
    header.message,
    continuationLines,
    messageAnalysis.category,
  );

  const entry = {
    type: "minecraft-log",
    category: messageAnalysis.category,
    timestamp: header.timestamp,
    thread: header.thread,
    level: header.level,
    logger: header.logger,
    message: header.message,
    summary: messageAnalysis.summary,
    raw: blockLines.join("\n"),
    lines: blockLines,
    lineStart: startIndex + 1,
    lineEnd: nextIndex,
    fold: {
      stablePrefix: messageAnalysis.stablePrefix,
      variableSuffix: messageAnalysis.variableSuffix,
      normalizedMessage: messageAnalysis.normalizedMessage,
      key: buildFoldKey(header, messageAnalysis),
    },
  };

  if (continuationLines.length > 0) {
    entry.continuation = continuationLines;
    entry.blockType = classifyContinuationBlock(
      header.message,
      continuationLines,
    );
  }

  if (details) {
    entry.details = details;
  }

  if (entry.blockType === "mod-list") {
    entry.modCount = details?.mods?.length ?? 0;
  }

  return entry;
}

/**
 * Build a final tooling entry from one or more loose lines.
 *
 * @param {string[]} blockLines - Lines included in the loose block.
 * @param {number} startIndex - Zero-based starting index for the block.
 * @returns {object} Final tooling log entry.
 */
function buildLooseEntry(blockLines, startIndex) {
  const firstLine = blockLines[0];
  const category = categorizeLooseLine(firstLine);
  const analysis = analyzeMessage(firstLine, {
    level: null,
    logger: null,
    thread: null,
  });
  const details = extractLooseDetails(blockLines, category);

  return {
    type: "tooling-log",
    category,
    message: firstLine.trim(),
    summary: analysis.summary,
    raw: blockLines.join("\n"),
    lines: blockLines,
    lineStart: startIndex + 1,
    lineEnd: startIndex + blockLines.length,
    fold: {
      stablePrefix: analysis.stablePrefix,
      variableSuffix: analysis.variableSuffix,
      normalizedMessage: analysis.normalizedMessage,
      key: `tooling|${category}|${analysis.normalizedMessage}`,
    },
    details,
  };
}

/**
 * Analyze a message to derive category and folding metadata.
 *
 * @param {string} message - Message text to analyze.
 * @param {{ level: string | null, logger: string | null, thread: string | null }} context - Context from the parent log entry.
 * @returns {{ category: string, summary: string, stablePrefix: string, variableSuffix: string, normalizedMessage: string }} Analysis result.
 */
function analyzeMessage(message, context) {
  const cleaned = message.trim();
  const stablePrefix = inferStablePrefix(cleaned);
  const variableSuffix = cleaned.startsWith(stablePrefix)
    ? cleaned.slice(stablePrefix.length).trim()
    : "";
  const normalizedMessage = normalizeForFold(cleaned);
  const category = categorizeStructuredMessage(cleaned, context);
  const summary = stablePrefix || cleaned;

  return {
    category,
    summary,
    stablePrefix,
    variableSuffix,
    normalizedMessage,
  };
}

/**
 * Infer the stable prefix of a message for grouping/folding repeated lines.
 *
 * @param {string} message - Message text to inspect.
 * @returns {string} Stable prefix suitable for fold grouping.
 */
function inferStablePrefix(message) {
  const tagged = message.match(/^\[(?<tag>[^\]]+)\]\s*(?<rest>.+)$/);
  if (tagged) {
    const restPrefix = inferStablePrefix(tagged.groups.rest);
    if (restPrefix.startsWith(":")) {
      return `[${tagged.groups.tag}]${restPrefix}`;
    }

    return `[${tagged.groups.tag}] ${restPrefix}`.trim();
  }

  const loadingModsMatch = message.match(/^(Loading)\s+\d+\s+(mods:?)$/i);
  if (loadingModsMatch) {
    return `${loadingModsMatch[1]} ${loadingModsMatch[2]}`;
  }

  const separators = [": ", " - ", " = "];
  for (const separator of separators) {
    const index = message.indexOf(separator);
    if (index > 0) {
      const before = message.slice(0, index + separator.length).trimEnd();
      const after = message.slice(index + separator.length);
      if (looksVariable(after)) {
        return before;
      }
    }
  }

  const tokenMatch = message.match(
    /^(?<prefix>.*?\b(?:spawned|loaded|loading|saving|created|preparing|starting|stopping|resizing|registered|registering|logged in|joined|left|authorize(?:d)?|failed|error|warning|getHeight|populateBiomes|populateNoise|buildSurface|carve)\b:?)/i,
  );
  if (tokenMatch?.groups.prefix) {
    return tokenMatch.groups.prefix.trim();
  }

  const bracketTailIndex = message.search(/\s[\[(]-?\d/);
  if (bracketTailIndex > 0) {
    return message.slice(0, bracketTailIndex).trim();
  }

  const numericTailIndex = message.search(/\s-?\d/);
  if (numericTailIndex > 0) {
    return message.slice(0, numericTailIndex).trim();
  }

  return message;
}

/**
 * Normalize changing parts of a message into placeholders for fold comparisons.
 *
 * @param {string} message - Message text to normalize.
 * @returns {string} Normalized message string.
 */
function normalizeForFold(message) {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "{uuid}")
    .replace(/\b\d{2}:\d{2}:\d{2}\b/g, "{time}")
    .replace(/\b-?\d+(?:\.\d+)?%?\b/g, "{n}")
    .replace(/"[^"]*"/g, '"{text}"')
    .replace(/'[^']*'/g, "'{text}'")
    .replace(/\[[^\]]*\]/g, (match) =>
      containsDigits(match) ? "[{values}]" : match,
    )
    .replace(/\([^)]*\)/g, (match) =>
      containsDigits(match) ? "({values})" : match,
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build a stable fold key for a structured Minecraft log entry.
 *
 * @param {{ level: string | null, logger: string | null }} header - Parsed header fields.
 * @param {{ stablePrefix: string, normalizedMessage: string }} messageAnalysis - Derived message analysis data.
 * @returns {string} Unique fold/grouping key.
 */
function buildFoldKey(header, messageAnalysis) {
  return [
    "minecraft",
    header.level || "UNKNOWN",
    header.logger || "unknown-logger",
    messageAnalysis.stablePrefix || messageAnalysis.normalizedMessage,
  ].join("|");
}

/**
 * Categorize a structured Minecraft log message.
 *
 * @param {string} message - Message body without timestamp/thread prefix.
 * @param {{ level: string | null, logger: string | null, thread: string | null }} context - Context from the structured line.
 * @returns {string} Best-fit log category.
 */
function categorizeStructuredMessage(message, context) {
  const lower = message.toLowerCase();
  const logger = (context.logger || "").toLowerCase();
  const thread = (context.thread || "").toLowerCase();
  const level = context.level || "";

  if (/realm|authorize/.test(lower)) {
    return "auth";
  }

  if (
    /starting integrated minecraft server|starting server|stopping server|saving worlds|saving chunks|all chunks are saved|all dimensions are saved/i.test(
      lower,
    )
  ) {
    return "server-lifecycle";
  }

  if (
    level === "ERROR" ||
    /exception|crash|failed|could not|unable to|error/i.test(message)
  ) {
    return "error";
  }

  if (level === "WARN" || /warn|deprecated/i.test(message)) {
    return "warning";
  }

  if (/\[chat\]|\[not secure\]|<[^>]+>/.test(lower)) {
    return "chat";
  }

  if (/loading \d+ mods:/.test(lower)) {
    return "mod-list";
  }

  if (/mixin/.test(lower) || logger.includes("mixin")) {
    return "mixin";
  }

  if (
    /fabricloader|forge|neoforge|modlauncher/.test(logger) ||
    /loading minecraft|fabric loader|forge/i.test(message)
  ) {
    return "loader";
  }

  if (
    /recipe|advancement|resource ?manager|assets|unifont|reload/i.test(lower)
  ) {
    return "resource-loading";
  }

  if (
    /preparing spawn area|selecting global world spawn|populate|buildsurface|carve|getheight|chunk|biome/i.test(
      lower,
    )
  ) {
    return "worldgen";
  }

  if (
    /render|atlas|lwjgl|openal|ubo|indigo|renderer|texture/i.test(lower) ||
    thread.includes("render")
  ) {
    return "rendering";
  }

  if (/logged in|joined the game|left the game|lost connection/.test(lower)) {
    return "player-event";
  }

  if (/modif|register|initializing|hello fabric world/.test(lower)) {
    return "startup";
  }

  return "unknown";
}

/**
 * Classify a structured continuation block.
 *
 * @param {string} message - Header message for the block.
 * @param {string[]} continuationLines - Lines merged into the block.
 * @returns {string} Continuation block type.
 */
function classifyContinuationBlock(message, continuationLines) {
  if (isModListHeader(message) && continuationLines.every(isModListItem)) {
    return "mod-list";
  }

  if (continuationLines.some(isStackTraceLine)) {
    return "stack-trace";
  }

  return "continuation";
}

/**
 * Extract structured details from a Minecraft log entry.
 *
 * @param {string} message - Parsed message body.
 * @param {string[]} continuationLines - Continuation lines attached to the entry.
 * @param {string} category - Entry category.
 * @returns {object | null} Extracted details, or `null` when nothing specific is found.
 */
function extractDetails(message, continuationLines, category) {
  const details = {};

  if (category === "chat") {
    const chatMatch = message.match(
      /\[(?:CHAT|Not Secure)\]\s*<(?<player>[^>]+)>\s*(?<text>.*)$/i,
    );
    if (chatMatch) {
      details.player = chatMatch.groups.player;
      details.text = chatMatch.groups.text;
    }
  }

  const progressMatch = message.match(
    /Preparing spawn area: (?<percent>\d+)%/i,
  );
  if (progressMatch) {
    details.progressPercent = Number(progressMatch.groups.percent);
  }

  const playerMatch = message.match(
    /(?<player>[\w.-]+)(?:\[.*\])? logged in with entity id (?<entityId>\d+) at \((?<x>-?\d+(?:\.\d+)?), (?<y>-?\d+(?:\.\d+)?), (?<z>-?\d+(?:\.\d+)?)\)/i,
  );
  if (playerMatch) {
    details.player = playerMatch.groups.player;
    details.entityId = Number(playerMatch.groups.entityId);
    details.position = {
      x: Number(playerMatch.groups.x),
      y: Number(playerMatch.groups.y),
      z: Number(playerMatch.groups.z),
    };
  }

  const coordinateMatch = message.match(
    /(?<action>[A-Za-z][\w$.:-]*):?\s*(?<coords>(?:\[\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?)?\s*\])|(?:-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?)?))$/,
  );
  if (coordinateMatch) {
    details.action = coordinateMatch.groups.action;
    details.coordinates = parseNumericList(coordinateMatch.groups.coords);
  }

  const resizeMatch = message.match(
    /Resizing (?<buffer>.+), capacity limit of (?<old>\d+) reached.*New capacity will be (?<next>\d+)\./i,
  );
  if (resizeMatch) {
    details.buffer = resizeMatch.groups.buffer;
    details.oldCapacity = Number(resizeMatch.groups.old);
    details.newCapacity = Number(resizeMatch.groups.next);
  }

  const atlasMatch = message.match(
    /Created:\s*(?<dimensions>\S+)\s+(?<asset>.+)$/i,
  );
  if (atlasMatch) {
    details.dimensions = atlasMatch.groups.dimensions;
    details.asset = atlasMatch.groups.asset;
  }

  if (continuationLines.length > 0 && continuationLines.every(isModListItem)) {
    details.mods = continuationLines.map(parseModListItem).filter(Boolean);
  }

  if (continuationLines.some(isStackTraceLine)) {
    details.exception = continuationLines.join("\n");
  }

  return Object.keys(details).length > 0 ? details : null;
}

/**
 * Extract structured details from a loose tooling block.
 *
 * @param {string[]} blockLines - Lines in the loose block.
 * @param {string} category - Loose block category.
 * @returns {object | null} Extracted details, or `null` when nothing specific is found.
 */
function extractLooseDetails(blockLines, category) {
  const firstLine = blockLines[0];
  const details = {};

  const execMatch = firstLine.match(/Executing '(?<task>[^']+)'/);
  if (execMatch) {
    details.task = execMatch.groups.task;
  }

  const finishedMatch = firstLine.match(
    /Execution (?:finished|failed) '(?<task>[^']+)'/,
  );
  if (finishedMatch) {
    details.task = finishedMatch.groups.task;
  }

  const gradleTaskMatch = firstLine.match(
    /^> Task (?<task>[^\s]+)(?: (?<status>.+))?$/,
  );
  if (gradleTaskMatch) {
    details.task = gradleTaskMatch.groups.task;
    details.status = gradleTaskMatch.groups.status?.trim() || "RUNNING";
  }

  if (category === "mod-list-block") {
    details.mods = blockLines.slice(1).map(parseModListItem).filter(Boolean);
  }

  return Object.keys(details).length > 0 ? details : null;
}

/**
 * Categorize a loose non-runtime log line.
 *
 * @param {string} line - Raw log line.
 * @returns {string} Best-fit category.
 */
function categorizeLooseLine(line) {
  const trimmed = line.trim();

  if (/^> Task /.test(trimmed)) {
    return "gradle-task";
  }

  if (/^> Configure project/.test(trimmed)) {
    return "gradle-phase";
  }

  if (/^BUILD SUCCESSFUL|^BUILD FAILED/.test(trimmed)) {
    return "build-result";
  }

  if (/^\d+\s+actionable tasks?:/.test(trimmed)) {
    return "task-summary";
  }

  if (/Execution (finished|failed)|Executing '.+'/.test(trimmed)) {
    return "runner";
  }

  if (/^Starting Gradle Daemon|^Gradle Daemon started/.test(trimmed)) {
    return "daemon";
  }

  if (/^-{3,}$/.test(trimmed)) {
    return "separator";
  }

  if (/^[A-Z][A-Z0-9 _-]+$/.test(trimmed)) {
    return "heading";
  }

  if (/:\s*$/.test(trimmed) && isModListHeader(trimmed)) {
    return "mod-list-block";
  }

  return "unknown";
}

/**
 * Determine whether a line should be merged into the current structured block.
 *
 * @param {string} line - Candidate continuation line.
 * @param {{ message: string }} header - Parsed header for the current block.
 * @returns {boolean} `true` if the line belongs to the block.
 */
function isContinuationLine(line, header) {
  if (line.trim() === "") {
    return false;
  }

  if (parseStructuredLine(line) || /^> Task /.test(line)) {
    return false;
  }

  if (isModListHeader(header.message) && isModListItem(line)) {
    return true;
  }

  return isStackTraceLine(line) || /^\s+/.test(line);
}

/**
 * Check whether a line looks like part of a Java stack trace.
 *
 * @param {string} line - Candidate line.
 * @returns {boolean} `true` if the line matches stack trace patterns.
 */
function isStackTraceLine(line) {
  return (
    /^\s+at\s/.test(line) ||
    /^\s*\.\.\. \d+ more$/.test(line) ||
    /^\s*Caused by:/.test(line) ||
    /^\s*Suppressed:/.test(line) ||
    /^\s*[A-Za-z0-9_$.]+(?:Exception|Error):/.test(line)
  );
}

/**
 * Check whether a loose line can start a multi-line tooling block.
 *
 * @param {string} line - Candidate header line.
 * @returns {boolean} `true` if the line can own continuation lines.
 */
function isLooseBlockHeader(line) {
  return /^> Task /.test(line) || /:$/.test(line.trim());
}

/**
 * Check whether a loose line should be appended to the current tooling block.
 *
 * @param {string} line - Candidate continuation line.
 * @returns {boolean} `true` if the line is a loose continuation.
 */
function isLooseContinuationLine(line) {
  return /^\s+/.test(line) || isModListItem(line);
}

/**
 * Check whether a message is a Fabric/loader mod list header.
 *
 * @param {string} message - Message text to inspect.
 * @returns {boolean} `true` if the message starts a mod list.
 */
function isModListHeader(message) {
  return /loading \d+ mods:$/i.test(message.trim());
}

/**
 * Check whether a line looks like a single mod list item.
 *
 * @param {string} line - Candidate line.
 * @returns {boolean} `true` if the line is a mod list item.
 */
function isModListItem(line) {
  return /^\s*-\s+.+\s+.+$/.test(line);
}

/**
 * Parse a single mod list item into name/version fields.
 *
 * @param {string} line - Raw mod list line.
 * @returns {{ name: string, version: string } | null} Parsed mod data, or `null` if the line does not match.
 */
function parseModListItem(line) {
  const match = line.match(/^\s*-\s+(?<name>[\w.-]+)\s+(?<version>.+)$/);
  if (!match) {
    return null;
  }

  return {
    name: match.groups.name,
    version: match.groups.version.trim(),
  };
}

/**
 * Heuristically determine whether a string contains variable data worth folding away.
 *
 * @param {string} value - Text to inspect.
 * @returns {boolean} `true` if the value appears variable.
 */
function looksVariable(value) {
  return (
    /-?\d/.test(value) ||
    /\[[^\]]+\]/.test(value) ||
    /\([^)]*\d[^)]*\)/.test(value) ||
    /<[^>]+>/.test(value) ||
    /[A-Fa-f0-9-]{8,}/.test(value)
  );
}

/**
 * Check whether a string contains any digits.
 *
 * @param {string} text - Text to inspect.
 * @returns {boolean} `true` if the text contains a digit.
 */
function containsDigits(text) {
  return /\d/.test(text);
}

/**
 * Parse all numeric values from a coordinate-like string.
 *
 * @param {string} text - Text containing comma-separated numeric values.
 * @returns {number[]} Parsed numbers in source order.
 */
function parseNumericList(text) {
  const matches = text.match(/-?\d+(?:\.\d+)?/g);
  return matches ? matches.map(Number) : [];
}

const scrollToTopButton = document.getElementById("scroll-to-top-button");
const customRulesPanel = document.getElementById("custom-rules-panel");
const ruleActionSelect = document.getElementById("rule-action");
const ruleKeywordField = document.getElementById("rule-keyword-field");
const ruleNumberIndexField = document.getElementById("rule-number-index-field");
const customRuleActionHelp = document.getElementById("custom-rule-action-help");

/**
 * Hide the custom display rules panel.
 *
 * @returns {void}
 */
const hideCustomRulesPanel = () => {
  customRulesPanel.setAttribute("hidden", "");
};
const ruleMatchValueInput = document.getElementById("rule-match-value");
const ruleActionValueInput = document.getElementById("rule-action-value");
const ruleNumberIndexSelect = document.getElementById("rule-number-index");

/**
 * Handle the "Group by Category" action for the currently selected log file.
 *
 * @returns {void}
 */
document.getElementById("group-by-category").addEventListener("click", async () => {
  hideCustomRulesPanel();
  const parsedLogs = await loadSelectedLogFile();
  if (!parsedLogs) {
    return;
  }

  const sortedLogs = categorise(parsedLogs);
  createDisplay(sortedLogs);
});

/**
 * Handle the "Fold Repeated Lines" action for the currently selected log file.
 *
 * @returns {void}
 */
document.getElementById("fold-repeated-lines").addEventListener("click", async () => {
  hideCustomRulesPanel();
  const parsedLogs = await loadSelectedLogFile();
  if (!parsedLogs) {
    return;
  }

  const foldedLogs = foldRepeatedLogs(parsedLogs);
  createFoldedDisplay(foldedLogs);
});

/**
 * Toggle the custom display rules panel.
 *
 * @returns {void}
 */
document.getElementById("custom-display-rules").addEventListener("click", () => {
  const isHidden = customRulesPanel.hasAttribute("hidden");

  if (isHidden) {
    customRulesPanel.removeAttribute("hidden");
    updateCustomRuleFields();
    return;
  }

  hideCustomRulesPanel();
});

/**
 * Update the rule form inputs based on the selected rule action.
 *
 * @returns {void}
 */
const updateCustomRuleFields = () => {
  const action = ruleActionSelect.value;
  const isTrimRule = action === "trim-before";

  ruleKeywordField.hidden = !isTrimRule;
  ruleNumberIndexField.hidden = isTrimRule;
  ruleActionValueInput.disabled = !isTrimRule;
  ruleNumberIndexSelect.disabled = isTrimRule;

  if (isTrimRule) {
    customRuleActionHelp.textContent =
      "Keep the important part of a matching line by trimming away the prefix before a keyword.";
    ruleMatchValueInput.placeholder = "e.g. [STDOUT]:";
    ruleActionValueInput.placeholder = "e.g. [STDOUT]:";
    return;
  }

  customRuleActionHelp.textContent =
    "From matching lines, keep only the entry with the lowest value and the entry with the highest value.";
  ruleMatchValueInput.placeholder = "e.g. getHeight:";
};

/**
 * Apply the configured custom display rule to the selected file and render the result.
 *
 * @returns {void}
 */
document.getElementById("apply-custom-rule").addEventListener("click", async () => {
  const parsedLogs = await loadSelectedLogFile();
  if (!parsedLogs) {
    return;
  }

  const rule = getCustomRuleInput();
  if (!rule) {
    return;
  }

  const results = applyCustomRule(parsedLogs, rule);
  createCustomRuleDisplay(rule, results);
});

ruleActionSelect.addEventListener("change", updateCustomRuleFields);
updateCustomRuleFields();

/**
 * Validate the chosen file as soon as the file input changes.
 *
 * @returns {void}
 */
document.getElementById("file-input").addEventListener("change", (event) => {
  const file = event.target.files?.[0];

  if (!file) {
    return;
  }

  if (!isSupportedLogFile(file)) {
    event.target.value = "";
    showUploadMessage("Please upload a plain-text .txt or .log file.");
    document.querySelector(".content-container").textContent = "";
    return;
  }

  hideUploadMessage();
});

/**
 * Toggle the visibility of the scroll-to-top button based on scroll position.
 *
 * @returns {void}
 */
const updateScrollToTopButtonVisibility = () => {
  if (window.scrollY > 200) {
    scrollToTopButton.classList.add("is-visible");
    return;
  }

  scrollToTopButton.classList.remove("is-visible");
};

/**
 * Smoothly scroll the window back to the top of the page.
 *
 * @returns {void}
 */
const scrollToTop = () => {
  window.scrollTo({
    top: 0,
    behavior: "smooth",
  });
};

window.addEventListener("scroll", updateScrollToTopButtonVisibility);
scrollToTopButton.addEventListener("click", scrollToTop);

/**
 * Read the selected file, validate it, and parse it into log objects.
 *
 * @returns {Promise<object[] | null>} Parsed logs, or `null` when no valid file is available.
 */
const loadSelectedLogFile = async () => {
  const file = document.getElementById("file-input").files[0];

  if (!file) {
    showUploadMessage("No file uploaded. Please try again.");
    return null;
  }

  if (!isSupportedLogFile(file)) {
    document.getElementById("file-input").value = "";
    showUploadMessage("Please upload a plain-text .txt or .log file.");
    return null;
  }

  hideUploadMessage();

  const text = await file.text();
  return parseLogFile(text);
};

/**
 * Read the current custom rule form and convert it into a usable rule object.
 *
 * @returns {object | null} Normalized rule object, or `null` if required fields are missing.
 */
const getCustomRuleInput = () => {
  const matchValue = ruleMatchValueInput.value.trim();
  const action = ruleActionSelect.value;
  const actionValue = ruleActionValueInput.value.trim();
  const numberIndex = Number(ruleNumberIndexSelect.value);

  if (!matchValue) {
    showUploadMessage("Please enter text to match before applying a custom rule.");
    return null;
  }

  if (action === "trim-before" && !actionValue) {
    showUploadMessage("Please enter the keyword to trim from.");
    return null;
  }

  hideUploadMessage();

  return {
    matchValue,
    action,
    actionValue,
    numberIndex,
  };
};

/**
 * Apply a custom display rule to parsed logs.
 *
 * @param {object[]} parsedLogs - Parsed log entries.
 * @param {{ matchValue: string, action: string, actionValue: string, numberIndex: number }} rule - Rule definition.
 * @returns {object[]} Transformed rule result entries.
 */
const applyCustomRule = (parsedLogs, rule) => {
  const matchingLogs = parsedLogs.filter((log) => logMatchesRule(log, rule.matchValue));

  if (rule.action === "trim-before") {
    return matchingLogs
      .map((log) => transformLogTrimBefore(log, rule.actionValue))
      .filter(Boolean);
  }

  if (rule.action === "show-min-max") {
    return transformLogsMinMax(matchingLogs, rule.numberIndex);
  }

  return [];
};

/**
 * Check whether a parsed log matches the provided custom rule text.
 *
 * @param {object} log - Parsed log object.
 * @param {string} matchValue - Text that should appear in the log.
 * @returns {boolean} `true` if the log matches the rule text.
 */
const logMatchesRule = (log, matchValue) => {
  const searchableText = [log.raw, log.message, log.summary]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  return searchableText.includes(matchValue.toLowerCase());
};

/**
 * Transform a log by trimming everything before a keyword.
 *
 * @param {object} log - Parsed log object.
 * @param {string} keyword - Keyword to trim from.
 * @returns {object | null} Transformed result object, or `null` if the keyword is not found.
 */
const transformLogTrimBefore = (log, keyword) => {
  const sources = [log.raw, log.message].filter(Boolean);

  for (const source of sources) {
    const keywordIndex = source.indexOf(keyword);
    if (keywordIndex === -1) {
      continue;
    }

    const trimmed = source.slice(keywordIndex + keyword.length).trim();
    return {
      type: "trim-before-result",
      title: trimmed || keyword,
      subtitle: log.summary || log.message || log.raw,
      raw: log.raw || log.message || "",
      category: log.category,
      timestamp: log.timestamp,
      logger: log.logger,
      thread: log.thread,
      lineStart: log.lineStart,
      lineEnd: log.lineEnd,
    };
  }

  return null;
};

/**
 * Keep only the minimum and maximum matching logs based on one extracted numeric value.
 *
 * @param {object[]} logs - Matching parsed log entries.
 * @param {number} numberIndex - Zero-based numeric index to compare.
 * @returns {object[]} Min/max result entries.
 */
const transformLogsMinMax = (logs, numberIndex) => {
  const withNumbers = logs
    .map((log) => {
      const values = parseNumericList(log.message || log.raw || "");
      return {
        log,
        compareValue: values[numberIndex],
      };
    })
    .filter((entry) => Number.isFinite(entry.compareValue));

  if (withNumbers.length === 0) {
    return [];
  }

  const sorted = [...withNumbers].sort((a, b) => a.compareValue - b.compareValue);
  const minEntry = sorted[0];
  const maxEntry = sorted[sorted.length - 1];
  const entries =
    minEntry.log === maxEntry.log
      ? [{ ...minEntry, resultLabel: "Minimum / Maximum" }]
      : [
          { ...minEntry, resultLabel: "Minimum" },
          { ...maxEntry, resultLabel: "Maximum" },
        ];

  return entries.map((entry) => ({
    type: "min-max-result",
    title: entry.log.summary || entry.log.message || entry.log.raw,
    subtitle: `${entry.resultLabel}: ${entry.compareValue}`,
    raw: entry.log.raw || entry.log.message || "",
    category: entry.log.category,
    timestamp: entry.log.timestamp,
    logger: entry.log.logger,
    thread: entry.log.thread,
    lineStart: entry.log.lineStart,
    lineEnd: entry.log.lineEnd,
    compareValue: entry.compareValue,
    resultLabel: entry.resultLabel,
  }));
};

/**
 * Check whether an uploaded file looks like a supported plain-text log file.
 *
 * @param {File} file - Uploaded browser file object.
 * @returns {boolean} `true` when the file has a supported extension and text MIME type.
 */
const isSupportedLogFile = (file) => {
  const fileName = file.name.toLowerCase();
  const hasValidExtension = fileName.endsWith(".txt") || fileName.endsWith(".log");
  const hasValidMimeType = file.type === "" || file.type === "text/plain";

  return hasValidExtension && hasValidMimeType;
};

/**
 * Show the upload feedback message with custom text.
 *
 * @param {string} message - Message to display to the user.
 * @returns {void}
 */
const showUploadMessage = (message) => {
  const messageElement = document.getElementById("no-file-uploaded-text");
  messageElement.textContent = message;
  messageElement.style.display = "block";
};

/**
 * Hide the upload feedback message.
 *
 * @returns {void}
 */
const hideUploadMessage = () => {
  document.getElementById("no-file-uploaded-text").style.display = "none";
};

/**
 * Group parsed logs into an object keyed by category.
 *
 * @param {object[]} parse - Parsed log entries.
 * @returns {Record<string, object[]>} Category map of parsed log arrays.
 */
const categorise = (parse) => {
  const sortedLogs = {};

  parse.forEach((log) => {
    if (sortedLogs[log.category]) {
      sortedLogs[log.category].push(log);
    } else {
      sortedLogs[log.category] = [];
      sortedLogs[log.category].push(log);
    }
  });

  return sortedLogs;
};

/**
 * Render the grouped-by-category display into the main content container.
 *
 * @param {Record<string, object[]>} sortedLogs - Parsed logs grouped by category.
 * @returns {void}
 */
const createDisplay = (sortedLogs) => {
  const display = document.querySelector(".content-container");
  display.textContent = "";

  Object.entries(sortedLogs).forEach(([category, logs]) => {
    display.append(createCategorySection(category, logs));
  });
};

/**
 * Render the custom-rule output into the main content container.
 *
 * @param {{ matchValue: string, action: string }} rule - Applied rule definition.
 * @param {object[]} results - Transformed rule results.
 * @returns {void}
 */
const createCustomRuleDisplay = (rule, results) => {
  const display = document.querySelector(".content-container");
  display.textContent = "";

  const section = createHtmlElement("section", "log-container");
  const header = createHtmlElement("div", "category-container");
  const title = createHtmlElement(
    "span",
    "category-label",
    `Custom Rule: ${formatCustomRuleTitle(rule)}`
  );
  const count = createHtmlElement(
    "span",
    "log-category-chip",
    `${results.length} result${results.length === 1 ? "" : "s"}`
  );
  const listings = createHtmlElement("ul", "listing-container");

  header.append(title, count);
  section.append(header, listings);

  if (results.length === 0) {
    const emptyState = createHtmlElement(
      "p",
      "custom-rule-empty",
      "No matching log lines were found for this rule."
    );
    section.append(emptyState);
    display.append(section);
    return;
  }

  results.forEach((result) => {
    listings.append(createCustomRuleListing(result));
  });

  display.append(section);
};

/**
 * Build a short readable title for the active custom rule.
 *
 * @param {{ matchValue: string, action: string, actionValue?: string }} rule - Applied rule definition.
 * @returns {string} Human-readable rule title.
 */
const formatCustomRuleTitle = (rule) => {
  if (rule.action === "trim-before") {
    return `trim before "${rule.actionValue}" on lines containing "${rule.matchValue}"`;
  }

  return `show min/max for lines containing "${rule.matchValue}"`;
};

/**
 * Fold consecutive repeated logs using their stable fold key.
 *
 * @param {object[]} logs - Parsed log entries.
 * @returns {object[]} Folded log groups in original order.
 */
const foldRepeatedLogs = (logs) => {
  if (logs.length === 0) {
    return [];
  }

  const foldedGroups = [];
  let currentGroup = createFoldGroup(logs[0]);

  for (let index = 1; index < logs.length; index += 1) {
    const log = logs[index];

    if (log.fold?.key === currentGroup.foldKey) {
      currentGroup.logs.push(log);
      currentGroup.count += 1;
      currentGroup.endLine = log.lineEnd || log.lineStart || currentGroup.endLine;
      currentGroup.lastTimestamp = log.timestamp || currentGroup.lastTimestamp;
      continue;
    }

    foldedGroups.push(currentGroup);
    currentGroup = createFoldGroup(log);
  }

  foldedGroups.push(currentGroup);

  return foldedGroups;
};

/**
 * Create a folded repeated-line group from a single parsed log.
 *
 * @param {object} log - Parsed log object.
 * @returns {object} Folded group.
 */
const createFoldGroup = (log) => {
  return {
    foldKey: log.fold?.key || log.raw,
    summary: log.fold?.stablePrefix || log.summary || log.message || log.raw,
    category: log.category,
    level: log.level || "unknown",
    logger: log.logger || log.type || "unknown-source",
    thread: log.thread || "",
    firstTimestamp: log.timestamp || "",
    lastTimestamp: log.timestamp || "",
    startLine: log.lineStart || null,
    endLine: log.lineEnd || log.lineStart || null,
    count: 1,
    logs: [log]
  };
};

/**
 * Render folded repeated-line groups.
 *
 * @param {object[]} foldedLogs - Folded repeated-line groups.
 * @returns {void}
 */
const createFoldedDisplay = (foldedLogs) => {
  const display = document.querySelector(".content-container");
  display.textContent = "";

  const section = createHtmlElement("section", "log-container");
  const header = createHtmlElement(
    "div",
    "category-container",
    `Folded repeated lines: ${foldedLogs.length} groups`
  );
  const listings = createHtmlElement("ul", "listing-container");

  section.append(header, listings);

  foldedLogs.forEach((group) => {
    listings.append(createFoldedListing(group));
  });

  display.append(section);
};

/**
 * Create a full category section with a header and all of its log listings.
 *
 * @param {string} category - Log category name.
 * @param {object[]} logs - Logs that belong to the category.
 * @returns {HTMLElement} Rendered category section.
 */
const createCategorySection = (category, logs) => {
  const section = createHtmlElement("section", "log-container");
  const header = createHtmlElement("div", "category-container");
  const label = createHtmlElement(
    "span",
    "category-label",
    `${category}: ${logs.length} entr${logs.length === 1 ? "y" : "ies"}`
  );
  const arrowIcon = createArrowSvg();
  const listingContainer = createHtmlElement("ul", "listing-container");

  listingContainer.style.display = "none";
  arrowIcon.classList.add("category-toggle");
  arrowIcon.style.cursor = "pointer";
  arrowIcon.style.transform = "rotate(-90deg)";

  header.append(label, arrowIcon);
  section.append(header, listingContainer);

  logs.forEach((log) => {
    listingContainer.append(createLogListing(log));
  });

  const toggleCategory = () => {
    const isHidden = listingContainer.style.display === "none";
    listingContainer.style.display = isHidden ? "" : "none";
    arrowIcon.style.transform = isHidden ? "rotate(0deg)" : "rotate(-90deg)";
  };

  header.style.cursor = "pointer";
  header.addEventListener("click", toggleCategory);

  return section;
};

/**
 * Create a list item representing a single parsed log object.
 *
 * @param {object} log - Parsed log object.
 * @returns {HTMLLIElement} Rendered log list item.
 */
const createLogListing = (log) => {
  const listing = createHtmlElement("li", "log-listing");
  const header = createHtmlElement("div", "log-folded-header");
  const primaryRow = createHtmlElement("div", "log-primary-row");
  const secondaryRow = createHtmlElement("div", "log-secondary-row");
  const arrowIcon = createArrowSvg();
  const rawMessage = createHtmlElement("pre", "log-raw", log.raw || log.message || "");

  rawMessage.style.display = "none";
  arrowIcon.classList.add("category-toggle");
  arrowIcon.style.transform = "rotate(-90deg)";

  const timestamp = createHtmlElement("span", "log-timestamp", log.timestamp || "No time");
  const level = createHtmlElement("span", "log-level", log.level || log.category || "unknown");
  const summary = createHtmlElement(
    "span",
    "log-summary",
    log.summary || log.message || log.raw || "No summary"
  );
  const logger = createHtmlElement("span", "log-logger", log.logger || log.type || "unknown-source");

  primaryRow.append(timestamp, level, summary);
  secondaryRow.append(logger);

  if (log.thread) {
    secondaryRow.append(createHtmlElement("span", "log-thread", log.thread));
  }

  if (log.details?.coordinates) {
    secondaryRow.append(
      createHtmlElement("span", "log-coordinates", `[${log.details.coordinates.join(", ")}]`)
    );
  }

  if (log.details?.player) {
    secondaryRow.append(createHtmlElement("span", "log-player", `player: ${log.details.player}`));
  }

  if (log.details?.text) {
    secondaryRow.append(createHtmlElement("span", "log-text", `"${log.details.text}"`));
  }

  if (log.fold?.variableSuffix) {
    secondaryRow.append(
      createHtmlElement("span", "log-variable-suffix", `value: ${log.fold.variableSuffix}`)
    );
  }

  if (typeof log.modCount === "number") {
    secondaryRow.append(createHtmlElement("span", "log-mod-count", `${log.modCount} mods`));
  }

  if (log.blockType) {
    secondaryRow.append(createHtmlElement("span", "log-block-type", `block: ${log.blockType}`));
  }

  if (log.details?.progressPercent !== undefined) {
    secondaryRow.append(
      createHtmlElement("span", "log-progress", `progress: ${log.details.progressPercent}%`)
    );
  }

  if (log.details?.buffer && log.details?.newCapacity !== undefined) {
    secondaryRow.append(
      createHtmlElement(
        "span",
        "log-buffer",
        `${log.details.buffer}: ${log.details.oldCapacity} -> ${log.details.newCapacity}`
      )
    );
  }

  if (log.details?.asset) {
    secondaryRow.append(createHtmlElement("span", "log-asset", log.details.asset));
  }

  if (log.lineStart && log.lineEnd) {
    const lineLabel =
      log.lineStart === log.lineEnd
        ? `line ${log.lineStart}`
        : `lines ${log.lineStart}-${log.lineEnd}`;
    secondaryRow.append(createHtmlElement("span", "log-line-range", lineLabel));
  }

  header.append(primaryRow, arrowIcon);
  listing.append(header, secondaryRow, rawMessage);

  const toggleListing = () => {
    const isHidden = rawMessage.style.display === "none";
    rawMessage.style.display = isHidden ? "block" : "none";
    arrowIcon.style.transform = isHidden ? "rotate(0deg)" : "rotate(-90deg)";
  };

  header.style.cursor = "pointer";
  header.addEventListener("click", toggleListing);

  return listing;
};

/**
 * Create a rendered list item for a custom-rule result.
 *
 * @param {object} result - Transformed custom-rule result.
 * @returns {HTMLLIElement} Rendered rule result listing.
 */
const createCustomRuleListing = (result) => {
  const listing = createHtmlElement("li", "log-listing");
  const header = createHtmlElement("div", "log-folded-header");
  const primaryRow = createHtmlElement("div", "log-primary-row");
  const secondaryRow = createHtmlElement("div", "log-secondary-row");
  const arrowIcon = createArrowSvg();
  const rawMessage = createHtmlElement("pre", "log-raw", result.raw || "");

  rawMessage.style.display = "none";
  arrowIcon.classList.add("category-toggle");
  arrowIcon.style.transform = "rotate(-90deg)";

  primaryRow.append(
    createHtmlElement("span", "log-timestamp", result.timestamp || "No time"),
    createHtmlElement("span", "log-category-chip", result.category || "unknown")
  );

  if (result.resultLabel) {
    primaryRow.append(createHtmlElement("span", "log-min-max-label", result.resultLabel));
  }

  primaryRow.append(createHtmlElement("span", "log-summary", result.title || "No result"));

  if (result.subtitle) {
    secondaryRow.append(createHtmlElement("span", "log-variable-suffix", result.subtitle));
  }

  if (result.logger) {
    secondaryRow.append(createHtmlElement("span", "log-logger", result.logger));
  }

  if (result.thread) {
    secondaryRow.append(createHtmlElement("span", "log-thread", result.thread));
  }

  if (result.lineStart && result.lineEnd) {
    const lineLabel =
      result.lineStart === result.lineEnd
        ? `line ${result.lineStart}`
        : `lines ${result.lineStart}-${result.lineEnd}`;
    secondaryRow.append(createHtmlElement("span", "log-line-range", lineLabel));
  }

  header.append(primaryRow, arrowIcon);
  listing.append(header, secondaryRow, rawMessage);

  const toggleListing = () => {
    const isHidden = rawMessage.style.display === "none";
    rawMessage.style.display = isHidden ? "block" : "none";
    arrowIcon.style.transform = isHidden ? "rotate(0deg)" : "rotate(-90deg)";
  };

  header.style.cursor = "pointer";
  header.addEventListener("click", toggleListing);

  return listing;
};

/**
 * Create a list item representing a folded repeated-line group.
 *
 * @param {object} group - Folded repeated-line group.
 * @returns {HTMLLIElement} Rendered folded listing.
 */
const createFoldedListing = (group) => {
  const listing = createHtmlElement("li", "log-listing");
  const header = createHtmlElement("div", "log-folded-header");
  const primaryRow = createHtmlElement("div", "log-primary-row");
  const secondaryRow = createHtmlElement("div", "log-secondary-row");
  const arrowIcon = createArrowSvg();
  const rawMessage = createHtmlElement(
    "pre",
    "log-raw",
    group.logs.map((log) => log.raw || log.message || "").join("\n")
  );

  rawMessage.style.display = "none";
  arrowIcon.classList.add("category-toggle");
  arrowIcon.style.transform = "rotate(-90deg)";

  primaryRow.append(
    createHtmlElement("span", "log-timestamp", group.firstTimestamp || "No time"),
    createHtmlElement("span", "log-level", group.level),
    createHtmlElement("span", "log-summary", group.summary),
    createHtmlElement("span", "log-repeat-count", `x${group.count}`)
  );

  secondaryRow.append(
    createHtmlElement("span", "log-category-chip", group.category),
    createHtmlElement("span", "log-logger", group.logger)
  );

  if (group.thread) {
    secondaryRow.append(createHtmlElement("span", "log-thread", group.thread));
  }

  if (group.startLine && group.endLine) {
    const lineText =
      group.startLine === group.endLine
        ? `line ${group.startLine}`
        : `lines ${group.startLine}-${group.endLine}`;
    secondaryRow.append(createHtmlElement("span", "log-line-range", lineText));
  }

  if (group.count > 1 && group.firstTimestamp && group.lastTimestamp && group.firstTimestamp !== group.lastTimestamp) {
    secondaryRow.append(
      createHtmlElement("span", "log-time-span", `${group.firstTimestamp} -> ${group.lastTimestamp}`)
    );
  }

  header.append(primaryRow, arrowIcon);
  listing.append(header, secondaryRow, rawMessage);

  const toggleFoldedListing = () => {
    const isHidden = rawMessage.style.display === "none";
    rawMessage.style.display = isHidden ? "block" : "none";
    arrowIcon.style.transform = isHidden ? "rotate(0deg)" : "rotate(-90deg)";
  };

  header.style.cursor = "pointer";
  header.addEventListener("click", toggleFoldedListing);

  return listing;
};

/**
 * Create a standard HTML element with an optional class and text value.
 *
 * @param {string} tagName - HTML tag to create.
 * @param {string} [className] - Optional class name to apply.
 * @param {string} [textContent] - Optional text content to assign.
 * @returns {HTMLElement} Created DOM element.
 */
const createHtmlElement = (tagName, className = "", textContent = "") => {
  const element = document.createElement(tagName);

  if (className) {
    element.className = className;
  }

  if (textContent) {
    element.textContent = textContent;
  }

  return element;
};

/**
 * Create the arrow SVG element as a DOM node.
 *
 * @returns {SVGSVGElement} The constructed SVG element.
 */
const createArrowSvg = () => {
  const svgNamespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNamespace, "svg");
  const path = document.createElementNS(svgNamespace, "path");

  svg.setAttribute("xmlns", svgNamespace);
  svg.setAttribute("fill", "none");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("width", "15px");
  svg.setAttribute("height", "15px");
  svg.setAttribute("class", "size-6");
  

  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute(
    "d",
    "M19.5 13.5 12 21m0 0-7.5-7.5M12 21V3"
  );

  svg.append(path);

  return svg;
};
