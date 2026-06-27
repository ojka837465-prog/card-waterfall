var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => CardWaterfallPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var VIEW_TYPE = "card-waterfall-view";
var DEFAULT_SETTINGS = {
  inspirationsFolder: "灵感卡片",
  archivedFolder: "灵感卡片/归档",
  cardColumns: 3,
  showArchived: false
};
var TAG_COLORS = [
  "#B8B5C3",
  "#C5BBA8",
  "#A5B1C2",
  "#BCC8B6",
  "#C2B8C8",
  "#D4C4B7",
  "#B7C4C4",
  "#C4B8B8",
  "#B8C2B8",
  "#C8C2B4",
  "#B8B8C8",
  "#D0C4C0",
  "#BAC4C0",
  "#C4C0D0",
  "#C0C8C0"
];
function getTagColor(tag) {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  }
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}
function extractTitle(content) {
  const lines = content.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0)
    return "无标题";
  let title = lines[0];
  title = title.replace(/^#+\s+/, "");
  title = title.replace(/\*\*/g, "").replace(/\*/g, "");
  title = title.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  title = title.replace(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)+\s*/u, "");
  title = title.replace(/\p{Emoji_Presentation}|\p{Emoji}\uFE0F/gu, "");
  if (title.length > 16)
    title = title.slice(0, 16) + "…";
  return title.trim() || "无标题";
}
function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim() || "未命名";
}
var CardWaterfallPlugin = class extends import_obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new CardWaterfallView(leaf, this));
    this.addRibbonIcon("layers-3", "打开灵感卡片瀑布流", () => {
      this.activateView();
    });
    this.addCommand({
      id: "open-card-waterfall",
      name: "打开灵感卡片瀑布流",
      callback: () => this.activateView()
    });
    this.addSettingTab(new CardWaterfallSettingTab(this.app, this));
    if (this.app.workspace.getLeavesOfType(VIEW_TYPE).length === 0) {
      await this.activateView();
    }
  }
  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  async activateView() {
    const { workspace } = this.app;
    let leaf = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE, active: true });
      }
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }
  parseFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (match) {
      try {
        const frontmatter = (0, import_obsidian.parseYaml)(match[1]) || {};
        return { frontmatter, body: match[2].trim() };
      } catch (e) {
        return { frontmatter: {}, body: content };
      }
    }
    return { frontmatter: {}, body: content.trim() };
  }
  /** 读取所有卡片 */
  async loadCards() {
    const folderPath = this.settings.inspirationsFolder;
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder) {
      return [];
    }
    const files = this.app.vault.getMarkdownFiles().filter(
      (f) => f.path.startsWith(folderPath + "/") && f.extension === "md"
    );
    const cards = [];
    for (const file of files) {
      const raw = await this.app.vault.read(file);
      const { frontmatter, body } = this.parseFrontmatter(raw);
      cards.push({
        id: file.basename,
        content: body || "(空灵感)",
        title: frontmatter.title || extractTitle(body || ""),
        created: frontmatter.created ? new Date(frontmatter.created).getTime() : file.stat.ctime,
        pinned: frontmatter.pinned === true,
        archived: frontmatter.archived === true,
        tags: frontmatter.tags || [],
        file
      });
    }
    cards.sort((a, b) => {
      if (a.pinned && !b.pinned)
        return -1;
      if (!a.pinned && b.pinned)
        return 1;
      return b.created - a.created;
    });
    return cards;
  }
  /** 创建一条新灵感（改为语义化命名：时间_标题.md） */
  async createCard(content, tags = []) {
    const folderPath = this.settings.inspirationsFolder;
    const now = new Date();
    const title = extractTitle(content);
    const safeName = sanitizeFilename(title);
    const pad2 = (n) => n.toString().padStart(2, "0");
    const timePrefix = `${pad2(now.getMonth() + 1)}${pad2(now.getDate())}_${pad2(now.getHours())}${pad2(now.getMinutes())}`;
    const fileName = `${timePrefix}_${safeName}.md`;
    const filePath = `${folderPath}/${fileName}`;
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder) {
      await this.app.vault.createFolder(folderPath);
    }
    const frontmatter = {
      created: now.toISOString(),
      title,
      pinned: false,
      archived: false,
      tags
    };
    const fileContent = `---
${(0, import_obsidian.stringifyYaml)(frontmatter)}---

${content.trim()}
`;
    await this.app.vault.create(filePath, fileContent);
    new import_obsidian.Notice("✅ 灵感已记录");
  }
  /** 切换置顶状态 */
  async togglePin(file) {
    const raw = await this.app.vault.read(file);
    const { frontmatter, body } = this.parseFrontmatter(raw);
    frontmatter.pinned = !frontmatter.pinned;
    const newContent = `---
${(0, import_obsidian.stringifyYaml)(frontmatter)}---

${body}
`;
    await this.app.vault.modify(file, newContent);
  }
  /** 切换归档状态 */
  async toggleArchive(file) {
    const raw = await this.app.vault.read(file);
    const { frontmatter, body } = this.parseFrontmatter(raw);
    frontmatter.archived = !frontmatter.archived;
    const newContent = `---
${(0, import_obsidian.stringifyYaml)(frontmatter)}---

${body}
`;
    await this.app.vault.modify(file, newContent);
  }
  /** 更新卡片正文 */
  async updateCardContent(file, newBody) {
    const raw = await this.app.vault.read(file);
    const { frontmatter } = this.parseFrontmatter(raw);
    const newTitle = extractTitle(newBody);
    frontmatter.title = newTitle;
    const newContent = `---
${(0, import_obsidian.stringifyYaml)(frontmatter)}---

${newBody.trim()}
`;
    await this.app.vault.modify(file, newContent);
  }
  /** 删除一张卡片 */
  async deleteCard(file) {
    await this.app.vault.delete(file);
    new import_obsidian.Notice("🗑️ 灵感已删除");
  }
  /** 批量导出 */
  async batchExport(files) {
    if (files.length === 0) {
      new import_obsidian.Notice("请先选择要导出的卡片");
      return;
    }
    const lines = ["# 灵感导出\n"];
    const sorted = [...files].sort((a, b) => a.stat.ctime - b.stat.ctime);
    for (const file of sorted) {
      const raw = await this.app.vault.read(file);
      const { frontmatter, body } = this.parseFrontmatter(raw);
      const date = frontmatter.created ? new Date(frontmatter.created).toLocaleString("zh-CN") : "未知";
      lines.push(`## ${frontmatter.title || file.basename}`);
      lines.push(`> 时间：${date}`);
      if (frontmatter.pinned)
        lines.push("> 🔖 已置顶");
      lines.push("");
      lines.push(body);
      lines.push("");
      lines.push("---");
      lines.push("");
    }
    const exportContent = lines.join("\n");
    const exportPath = `灵感导出_${this.formatTimestamp(new Date())}.md`;
    await this.app.vault.create(exportPath, exportContent);
    new import_obsidian.Notice(`✅ 已导出 ${files.length} 条灵感到 ${exportPath}`);
  }
  formatTimestamp(date) {
    const pad = (n) => n.toString().padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }
};
var CardWaterfallView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.cards = [];
    this.selectedIds = /* @__PURE__ */ new Set();
    this.isSelectMode = false;
    this.showArchived = false;
    this.searchQuery = "";
    this.plugin = plugin;
    this.showArchived = plugin.settings.showArchived;
  }
  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "灵感卡片瀑布流";
  }
  getIcon() {
    return "layers-3";
  }
  async onOpen() {
    this.buildUI();
    await this.refreshCards();
  }
  buildUI() {
    const container = this.containerEl;
    container.empty();
    container.addClass("card-waterfall-container");
    const topBar = container.createDiv({ cls: "card-waterfall-topbar" });
    topBar.createEl("h3", {
      text: "💡 灵感瀑布流",
      cls: "card-waterfall-title"
    });
    this.searchInputEl = topBar.createEl("input", {
      type: "text",
      placeholder: "搜索灵感...",
      cls: "card-waterfall-search"
    });
    this.searchInputEl.addEventListener("input", () => {
      this.searchQuery = this.searchInputEl.value;
      this.renderCards();
    });
    this.toolbarEl = topBar.createDiv({ cls: "card-waterfall-toolbar" });
    const selectBtn = this.toolbarEl.createEl("button", {
      text: "选择",
      cls: "card-waterfall-btn"
    });
    selectBtn.addEventListener("click", () => this.toggleSelectMode());
    const exportBtn = this.toolbarEl.createEl("button", {
      text: "导出",
      cls: "card-waterfall-btn"
    });
    exportBtn.addEventListener("click", () => this.handleBatchExport());
    this.archiveBtnEl = this.toolbarEl.createEl("button", {
      text: this.showArchived ? "📂 显示全部" : "📦 归档",
      cls: "card-waterfall-btn"
    });
    this.archiveBtnEl.addEventListener("click", async () => {
      this.showArchived = !this.showArchived;
      this.archiveBtnEl.textContent = this.showArchived ? "📂 显示全部" : "📦 归档";
      await this.refreshCards();
    });
    const refreshBtn = this.toolbarEl.createEl("button", {
      text: "刷新",
      cls: "card-waterfall-btn"
    });
    refreshBtn.addEventListener("click", () => this.refreshCards());
    this.gridEl = container.createDiv({ cls: "card-waterfall-grid" });
    this.emptyStateEl = container.createDiv({ cls: "card-waterfall-empty" });
    this.emptyStateEl.innerHTML = `
      <div class="empty-icon">✨</div>
      <div class="empty-text">还没有灵感，写下你的第一条灵感吧！</div>
    `;
    this.inputAreaEl = container.createDiv({ cls: "card-waterfall-input-area" });
    const tagRow = this.inputAreaEl.createDiv({ cls: "card-input-tag-row" });
    const tagInput = tagRow.createEl("input", {
      type: "text",
      placeholder: "标签（可选，逗号分隔）",
      cls: "card-input-tags"
    });
    this.cardInputEl = this.inputAreaEl.createEl("textarea", {
      placeholder: "记录你的灵感...（支持 Markdown 格式）",
      cls: "card-waterfall-input",
      rows: 3
    });
    const submitBtn = this.inputAreaEl.createEl("button", {
      text: "发布灵感 💡",
      cls: "card-waterfall-submit"
    });
    this.cardInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleSubmit(tagInput);
      }
    });
    submitBtn.addEventListener("click", () => this.handleSubmit(tagInput));
    this.cardInputEl.addEventListener("input", () => {
      this.cardInputEl.style.height = "auto";
      this.cardInputEl.style.height =
        Math.min(this.cardInputEl.scrollHeight, 200) + "px";
    });
  }
  async handleSubmit(tagInput) {
    const text = this.cardInputEl.value.trim();
    if (!text) {
      new import_obsidian.Notice("请输入灵感内容");
      return;
    }
    const tags = tagInput.value.split(/[,，、\s]+/).map((t) => t.trim()).filter((t) => t.length > 0);
    await this.plugin.createCard(text, tags);
    this.cardInputEl.value = "";
    tagInput.value = "";
    this.cardInputEl.style.height = "auto";
    await this.refreshCards();
  }
  async refreshCards() {
    this.cards = await this.plugin.loadCards();
    this.renderCards();
  }
  renderCards() {
    this.gridEl.empty();
    const query = this.searchQuery.toLowerCase().trim();
    let filtered = this.cards;
    if (!this.showArchived) {
      filtered = filtered.filter((c) => !c.archived);
    }
    if (query) {
      filtered = filtered.filter(
        (c) =>
          c.content.toLowerCase().includes(query) ||
          c.title.toLowerCase().includes(query) ||
          c.tags.some((t) => t.toLowerCase().includes(query))
      );
    }
    if (filtered.length === 0) {
      this.gridEl.style.display = "none";
      if (this.cards.some((c) => c.archived) && !this.showArchived) {
        this.emptyStateEl.innerHTML = `
          <div class="empty-icon">📦</div>
          <div class="empty-text">所有灵感都已归档，点击「📦 归档」按钮查看</div>
        `;
      } else {
        this.emptyStateEl.innerHTML = `
          <div class="empty-icon">✨</div>
          <div class="empty-text">还没有灵感，写下你的第一条灵感吧！</div>
        `;
      }
      this.emptyStateEl.style.display = "flex";
      return;
    }
    this.gridEl.style.display = "";
    this.emptyStateEl.style.display = "none";
    for (const card of filtered) {
      const uniqueTags = [...new Set(card.tags)];
      const mainTagColor = uniqueTags.length > 0 ? getTagColor(uniqueTags[0]) : null;
      const cardEl = this.gridEl.createDiv({
        cls: "card-waterfall-card",
        attr: { "data-id": card.id }
      });
      if (mainTagColor) {
        if (card.archived) {
          cardEl.style.borderLeftColor = "var(--background-modifier-border)";
          cardEl.style.opacity = "0.65";
        } else {
          cardEl.style.borderLeftColor = mainTagColor;
        }
      }
      if (this.selectedIds.has(card.id)) {
        cardEl.addClass("is-selected");
      }
      if (card.pinned) {
        cardEl.addClass("is-pinned");
      }
      cardEl.addEventListener("click", async () => {
        if (this.isSelectMode)
          return;
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(card.file, { state: { mode: "source" } });
      });
      const header = cardEl.createDiv({ cls: "card-header" });
      if (card.pinned) {
        header.createSpan({ text: "📌 已置顶", cls: "card-pin-badge" });
      }
      if (uniqueTags.length > 0) {
        const tagDots = header.createSpan({ cls: "card-tag-dots" });
        for (const tag of uniqueTags) {
          const dot = tagDots.createSpan({
            cls: "card-tag-dot",
            attr: { title: tag }
          });
          dot.style.backgroundColor = getTagColor(tag);
        }
      }
      const time = header.createSpan({
        cls: "card-time",
        text: this.formatDate(card.created)
      });
      const titleEl = cardEl.createDiv({ cls: "card-title" });
      titleEl.textContent = card.title;
      const body = cardEl.createDiv({ cls: "card-body" });
      let bodyContent = card.content.replace(/^#{1,3}\s+.*(\n|$)/, "").trim();
      const MAX_LEN = 500;
      let isTruncated = false;
      if (bodyContent.length > MAX_LEN) {
        bodyContent = bodyContent.slice(0, MAX_LEN);
        isTruncated = true;
      }
      import_obsidian.MarkdownRenderer.render(
        this.app,
        bodyContent || card.content,
        body,
        card.file.path,
        this.plugin
      );
      if (isTruncated) {
        body.createEl("div", {
          cls: "card-expand-hint",
          text: "… 点击卡片展开查看完整内容"
        });
      }
      if (card.archived) {
        const archivedBadge = cardEl.createDiv({ cls: "card-archived-badge" });
        archivedBadge.textContent = "📦 已归档";
      }
      const actions = cardEl.createDiv({ cls: "card-actions" });
      if (this.isSelectMode) {
        const checkbox = actions.createEl("input", {
          type: "checkbox",
          cls: "card-checkbox"
        });
        checkbox.checked = this.selectedIds.has(card.id);
        checkbox.addEventListener("change", (e) => {
          e.stopPropagation();
          if (checkbox.checked) {
            this.selectedIds.add(card.id);
            cardEl.addClass("is-selected");
          } else {
            this.selectedIds.delete(card.id);
            cardEl.removeClass("is-selected");
          }
        });
      } else {
        const pinBtn = actions.createEl("button", {
          text: card.pinned ? "取消置顶" : "置顶",
          cls: "card-action-btn"
        });
        pinBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          await this.plugin.togglePin(card.file);
          await this.refreshCards();
        });
        const archiveBtn = actions.createEl("button", {
          text: card.archived ? "取消归档" : "归档",
          cls: "card-action-btn"
        });
        archiveBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          await this.plugin.toggleArchive(card.file);
          await this.refreshCards();
        });
        const editBtn = actions.createEl("button", {
          text: "编辑",
          cls: "card-action-btn"
        });
        editBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          await this.editCard(card);
        });
        const delBtn = actions.createEl("button", {
          text: "删除",
          cls: "card-action-btn card-action-danger"
        });
        delBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (confirm(`确定删除「${card.title}」？`)) {
            await this.plugin.deleteCard(card.file);
            await this.refreshCards();
          }
        });
      }
    }
  }
  async editCard(card) {
    const newContent = prompt("编辑灵感内容：", card.content);
    if (newContent !== null && newContent.trim()) {
      await this.plugin.updateCardContent(card.file, newContent);
      await this.refreshCards();
      new import_obsidian.Notice("✏️ 已更新");
    }
  }
  toggleSelectMode() {
    this.isSelectMode = !this.isSelectMode;
    if (!this.isSelectMode) {
      this.selectedIds.clear();
      new import_obsidian.Notice("已退出选择模式");
    } else {
      new import_obsidian.Notice("勾选卡片后点击「导出」批量导出");
    }
    this.renderCards();
  }
  async handleBatchExport() {
    if (!this.isSelectMode || this.selectedIds.size === 0) {
      this.isSelectMode = true;
      this.renderCards();
      new import_obsidian.Notice("请先勾选要导出的卡片");
      return;
    }
    const selectedFiles = this.cards
      .filter((c) => this.selectedIds.has(c.id))
      .map((c) => c.file);
    await this.plugin.batchExport(selectedFiles);
    this.isSelectMode = false;
    this.selectedIds.clear();
    this.renderCards();
  }
  formatDate(timestamp) {
    const d = new Date(timestamp);
    const pad = (n) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
};
var CardWaterfallSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "灵感卡片瀑布流 - 设置" });
    new import_obsidian.Setting(containerEl)
      .setName("灵感卡片存储文件夹")
      .setDesc("每条灵感将作为单独的 Markdown 文件存储在此文件夹中")
      .addText((text) =>
        text
          .setPlaceholder("灵感卡片")
          .setValue(this.plugin.settings.inspirationsFolder)
          .onChange(async (value) => {
            this.plugin.settings.inspirationsFolder = value || "灵感卡片";
            await this.plugin.saveSettings();
          })
      );
    new import_obsidian.Setting(containerEl)
      .setName("卡片列数")
      .setDesc("瀑布流显示的列数（桌面端推荐 3-4 列）")
      .addSlider((slider) =>
        slider
          .setLimits(1, 6, 1)
          .setValue(this.plugin.settings.cardColumns)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.cardColumns = value;
            await this.plugin.saveSettings();
            document.documentElement.style.setProperty(
              "--card-waterfall-columns",
              value.toString()
            );
          })
      );
  }
};
