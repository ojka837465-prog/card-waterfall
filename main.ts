import {
  App,
  ItemView,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
  TFile,
  Notice,
  MarkdownRenderer,
  parseYaml,
  stringifyYaml,
} from "obsidian";

// ─── 配置 ───────────────────────────────────────────────────────

const VIEW_TYPE = "card-waterfall-view";

interface CardWaterfallSettings {
  inspirationsFolder: string;
  archivedFolder: string;
  cardColumns: number;
  showArchived: boolean;
}

const DEFAULT_SETTINGS: CardWaterfallSettings = {
  inspirationsFolder: "灵感卡片",
  archivedFolder: "灵感卡片/归档",
  cardColumns: 3,
  showArchived: false,
};

// ─── 卡片接口 ──────────────────────────────────────────────────

interface CardData {
  id: string;
  content: string;
  title: string;
  created: number;
  pinned: boolean;
  archived: boolean;
  tags: string[];
  file: TFile;
}

// ─── 标签颜色映射 ──────────────────────────────────────────────

const TAG_COLORS = [
  "#B8B5C3", "#C5BBA8", "#A5B1C2", "#BCC8B6", "#C2B8C8",
  "#D4C4B7", "#B7C4C4", "#C4B8B8", "#B8C2B8", "#C8C2B4",
  "#B8B8C8", "#D0C4C0", "#BAC4C0", "#C4C0D0", "#C0C8C0",
];

function getTagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  }
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

// ─── 工具函数 ──────────────────────────────────────────────────

/** 从正文提取标题（去掉 emoji 和 Markdown 标记） */
function extractTitle(content: string): string {
  const lines = content.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return "无标题";

  let title = lines[0];
  // 去掉 Markdown 标题标记 #
  title = title.replace(/^#+\s+/, "");
  // 去掉粗体/斜体标记
  title = title.replace(/\*\*/g, "").replace(/\*/g, "");
  // 去掉链接语法
  title = title.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // 去掉开头的 emoji（如 🦈、📚 等）
  title = title.replace(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)+\s*/u, "");
  // 去掉残留的 emoji 字符
  title = title.replace(/\p{Emoji_Presentation}|\p{Emoji}\uFE0F/gu, "");
  // 限制长度
  if (title.length > 16) title = title.slice(0, 16) + "…";
  return title.trim() || "无标题";
}

/** 生成安全的文件名（替换非法字符） */
function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim() || "未命名";
}

// ─── 主插件 ────────────────────────────────────────────────────

export default class CardWaterfallPlugin extends Plugin {
  settings: CardWaterfallSettings;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new CardWaterfallView(leaf, this));

    this.addRibbonIcon("layers-3", "打开灵感卡片瀑布流", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-card-waterfall",
      name: "打开灵感卡片瀑布流",
      callback: () => this.activateView(),
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
    let leaf: WorkspaceLeaf | null = null;
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

  parseFrontmatter(content: string): {
    frontmatter: Record<string, unknown>;
    body: string;
  } {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (match) {
      try {
        const frontmatter = parseYaml(match[1]) || {};
        return { frontmatter, body: match[2].trim() };
      } catch {
        return { frontmatter: {}, body: content };
      }
    }
    return { frontmatter: {}, body: content.trim() };
  }

  /** 读取所有卡片 */
  async loadCards(): Promise<CardData[]> {
    const folderPath = this.settings.inspirationsFolder;
    const folder = this.app.vault.getAbstractFileByPath(folderPath);

    if (!folder) {
      return [];
    }

    const files = this.app.vault.getMarkdownFiles().filter(
      (f) => f.path.startsWith(folderPath + "/") && f.extension === "md"
    );

    const cards: CardData[] = [];

    for (const file of files) {
      const raw = await this.app.vault.read(file);
      const { frontmatter, body } = this.parseFrontmatter(raw);

      cards.push({
        id: file.basename,
        content: body || "(空灵感)",
        title: (frontmatter.title as string) || extractTitle(body || ""),
        created: frontmatter.created
          ? new Date(frontmatter.created as string).getTime()
          : file.stat.ctime,
        pinned: frontmatter.pinned === true,
        archived: frontmatter.archived === true,
        tags: (frontmatter.tags as string[]) || [],
        file,
      });
    }

    // 排序：置顶 > 创建时间倒序
    cards.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return b.created - a.created;
    });

    return cards;
  }

  /** 创建一条新灵感（改为语义化命名：时间_标题.md） */
  async createCard(content: string, tags: string[] = []): Promise<void> {
    const folderPath = this.settings.inspirationsFolder;
    const now = new Date();

    // 提取标题用于文件名
    const title = extractTitle(content);
    const safeName = sanitizeFilename(title);

    // 文件名格式：MMDD_HHmm_标题.md
    const pad2 = (n: number) => n.toString().padStart(2, "0");
    const timePrefix = `${pad2(now.getMonth() + 1)}${pad2(now.getDate())}_${pad2(now.getHours())}${pad2(now.getMinutes())}`;
    const fileName = `${timePrefix}_${safeName}.md`;
    const filePath = `${folderPath}/${fileName}`;

    // 确保文件夹存在
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder) {
      await this.app.vault.createFolder(folderPath);
    }

    const frontmatter: Record<string, unknown> = {
      created: now.toISOString(),
      title,
      pinned: false,
      archived: false,
      tags,
    };

    const fileContent = `---\n${stringifyYaml(frontmatter)}---\n\n${content.trim()}\n`;

    await this.app.vault.create(filePath, fileContent);
    new Notice("✅ 灵感已记录");
  }

  /** 切换置顶状态 */
  async togglePin(file: TFile): Promise<void> {
    const raw = await this.app.vault.read(file);
    const { frontmatter, body } = this.parseFrontmatter(raw);
    frontmatter.pinned = !frontmatter.pinned;

    const newContent = `---\n${stringifyYaml(frontmatter)}---\n\n${body}\n`;
    await this.app.vault.modify(file, newContent);
  }

  /** 切换归档状态 */
  async toggleArchive(file: TFile): Promise<void> {
    const raw = await this.app.vault.read(file);
    const { frontmatter, body } = this.parseFrontmatter(raw);
    frontmatter.archived = !frontmatter.archived;

    const newContent = `---\n${stringifyYaml(frontmatter)}---\n\n${body}\n`;
    await this.app.vault.modify(file, newContent);
  }

  /** 更新卡片正文 */
  async updateCardContent(file: TFile, newBody: string): Promise<void> {
    const raw = await this.app.vault.read(file);
    const { frontmatter } = this.parseFrontmatter(raw);

    // 同步更新 title
    const newTitle = extractTitle(newBody);
    frontmatter.title = newTitle;

    const newContent = `---\n${stringifyYaml(frontmatter)}---\n\n${newBody.trim()}\n`;
    await this.app.vault.modify(file, newContent);
  }

  /** 删除一张卡片 */
  async deleteCard(file: TFile): Promise<void> {
    await this.app.vault.delete(file);
    new Notice("🗑️ 灵感已删除");
  }

  /** 批量导出 */
  async batchExport(files: TFile[]): Promise<void> {
    if (files.length === 0) {
      new Notice("请先选择要导出的卡片");
      return;
    }

    const lines: string[] = ["# 灵感导出\n"];
    const sorted = [...files].sort((a, b) => a.stat.ctime - b.stat.ctime);

    for (const file of sorted) {
      const raw = await this.app.vault.read(file);
      const { frontmatter, body } = this.parseFrontmatter(raw);
      const date = frontmatter.created
        ? new Date(frontmatter.created as string).toLocaleString("zh-CN")
        : "未知";

      lines.push(`## ${(frontmatter.title as string) || file.basename}`);
      lines.push(`> 时间：${date}`);
      if (frontmatter.pinned) lines.push("> 🔖 已置顶");
      lines.push("");
      lines.push(body);
      lines.push("");
      lines.push("---");
      lines.push("");
    }

    const exportContent = lines.join("\n");
    const exportPath = `灵感导出_${this.formatTimestamp(new Date())}.md`;
    await this.app.vault.create(exportPath, exportContent);
    new Notice(`✅ 已导出 ${files.length} 条灵感到 ${exportPath}`);
  }

  private formatTimestamp(date: Date): string {
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }
}

// ─── 瀑布流视图 ────────────────────────────────────────────────

class CardWaterfallView extends ItemView {
  plugin: CardWaterfallPlugin;
  cards: CardData[] = [];
  selectedIds: Set<string> = new Set();
  isSelectMode: boolean = false;
  showArchived: boolean = false;
  searchQuery: string = "";

  // DOM 引用
  containerEl: HTMLElement;
  searchInputEl: HTMLInputElement;
  gridEl: HTMLElement;
  emptyStateEl: HTMLElement;
  inputAreaEl: HTMLElement;
  cardInputEl: HTMLTextAreaElement;
  toolbarEl: HTMLElement;
  archiveBtnEl: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: CardWaterfallPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.showArchived = plugin.settings.showArchived;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "灵感卡片瀑布流";
  }

  getIcon(): string {
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

    // ─── 顶部栏 ───
    const topBar = container.createDiv({ cls: "card-waterfall-topbar" });

    topBar.createEl("h3", {
      text: "💡 灵感瀑布流",
      cls: "card-waterfall-title",
    });

    this.searchInputEl = topBar.createEl("input", {
      type: "text",
      placeholder: "搜索灵感...",
      cls: "card-waterfall-search",
    });
    this.searchInputEl.addEventListener("input", () => {
      this.searchQuery = this.searchInputEl.value;
      this.renderCards();
    });

    // 工具栏
    this.toolbarEl = topBar.createDiv({ cls: "card-waterfall-toolbar" });

    const selectBtn = this.toolbarEl.createEl("button", {
      text: "选择",
      cls: "card-waterfall-btn",
    });
    selectBtn.addEventListener("click", () => this.toggleSelectMode());

    const exportBtn = this.toolbarEl.createEl("button", {
      text: "导出",
      cls: "card-waterfall-btn",
    });
    exportBtn.addEventListener("click", () => this.handleBatchExport());

    // 归档切换按钮
    this.archiveBtnEl = this.toolbarEl.createEl("button", {
      text: this.showArchived ? "📂 显示全部" : "📦 归档",
      cls: "card-waterfall-btn",
    });
    this.archiveBtnEl.addEventListener("click", async () => {
      this.showArchived = !this.showArchived;
      this.archiveBtnEl.textContent = this.showArchived ? "📂 显示全部" : "📦 归档";
      await this.refreshCards();
    });

    const refreshBtn = this.toolbarEl.createEl("button", {
      text: "刷新",
      cls: "card-waterfall-btn",
    });
    refreshBtn.addEventListener("click", () => this.refreshCards());

    // ─── 卡片网格 ───
    this.gridEl = container.createDiv({ cls: "card-waterfall-grid" });

    // ─── 空状态 ───
    this.emptyStateEl = container.createDiv({ cls: "card-waterfall-empty" });
    this.emptyStateEl.innerHTML = `
      <div class="empty-icon">✨</div>
      <div class="empty-text">还没有灵感，写下你的第一条灵感吧！</div>
    `;

    // ─── 底部标签栏 + 输入区 ───
    this.inputAreaEl = container.createDiv({ cls: "card-waterfall-input-area" });

    const tagRow = this.inputAreaEl.createDiv({ cls: "card-input-tag-row" });
    const tagInput = tagRow.createEl("input", {
      type: "text",
      placeholder: "标签（可选，逗号分隔）",
      cls: "card-input-tags",
    });

    this.cardInputEl = this.inputAreaEl.createEl("textarea", {
      placeholder: "记录你的灵感...（支持 Markdown 格式）",
      cls: "card-waterfall-input",
      rows: 3,
    });

    const submitBtn = this.inputAreaEl.createEl("button", {
      text: "发布灵感 💡",
      cls: "card-waterfall-submit",
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

  async handleSubmit(tagInput: HTMLInputElement) {
    const text = this.cardInputEl.value.trim();
    if (!text) {
      new Notice("请输入灵感内容");
      return;
    }

    const tags = tagInput.value
      .split(/[,，、\s]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

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

    // 按归档状态过滤
    if (!this.showArchived) {
      filtered = filtered.filter((c) => !c.archived);
    }

    // 按搜索过滤
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
      // 收集该卡片所有标签的颜色（去重取第一个作为主色，或渐变边框）
      const uniqueTags = [...new Set(card.tags)];
      const mainTagColor = uniqueTags.length > 0 ? getTagColor(uniqueTags[0]) : null;

      const cardEl = this.gridEl.createDiv({
        cls: "card-waterfall-card",
        attr: { "data-id": card.id },
      });

      // 根据标签设置边框颜色
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

      // ─── 点击整张卡片跳转编辑 ───
      cardEl.addEventListener("click", async () => {
        if (this.isSelectMode) return;
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(card.file, { state: { mode: "source" } });
      });

      // ─── 卡片头部：置顶标记 + 标签色条 + 时间 ───
      const header = cardEl.createDiv({ cls: "card-header" });

      if (card.pinned) {
        header.createSpan({ text: "📌 已置顶", cls: "card-pin-badge" });
      }

      // 标签彩色小圆点
      if (uniqueTags.length > 0) {
        const tagDots = header.createSpan({ cls: "card-tag-dots" });
        for (const tag of uniqueTags) {
          const dot = tagDots.createSpan({
            cls: "card-tag-dot",
            attr: { title: tag },
          });
          dot.style.backgroundColor = getTagColor(tag);
        }
      }

      const time = header.createSpan({
        cls: "card-time",
        text: this.formatDate(card.created),
      });

      // ─── 卡片标题（居中显示） ───
      const titleEl = cardEl.createDiv({ cls: "card-title" });
      titleEl.textContent = card.title;

      // ─── 卡片正文（跳过第一行标题，限制 300 字） ───
      const body = cardEl.createDiv({ cls: "card-body" });
      let bodyContent = card.content.replace(/^#{1,3}\s+.*(\n|$)/, "").trim();
      const MAX_LEN = 500;
      let isTruncated = false;
      if (bodyContent.length > MAX_LEN) {
        bodyContent = bodyContent.slice(0, MAX_LEN);
        isTruncated = true;
      }

      MarkdownRenderer.render(
        this.app,
        bodyContent || card.content,
        body,
        card.file.path,
        this.plugin
      );

      if (isTruncated) {
        body.createEl("div", {
          cls: "card-expand-hint",
          text: "… 点击卡片展开查看完整内容",
        });
      }

      // ─── 归档标记 ───
      if (card.archived) {
        const archivedBadge = cardEl.createDiv({ cls: "card-archived-badge" });
        archivedBadge.textContent = "📦 已归档";
      }

      // ─── 卡片操作区 ───
      const actions = cardEl.createDiv({ cls: "card-actions" });

      if (this.isSelectMode) {
        const checkbox = actions.createEl("input", {
          type: "checkbox",
          cls: "card-checkbox",
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
          cls: "card-action-btn",
        });
        pinBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          await this.plugin.togglePin(card.file);
          await this.refreshCards();
        });

        // 归档 / 取消归档按钮
        const archiveBtn = actions.createEl("button", {
          text: card.archived ? "取消归档" : "归档",
          cls: "card-action-btn",
        });
        archiveBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          await this.plugin.toggleArchive(card.file);
          await this.refreshCards();
        });

        const editBtn = actions.createEl("button", {
          text: "编辑",
          cls: "card-action-btn",
        });
        editBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          await this.editCard(card);
        });

        const delBtn = actions.createEl("button", {
          text: "删除",
          cls: "card-action-btn card-action-danger",
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

  async editCard(card: CardData) {
    const newContent = prompt("编辑灵感内容：", card.content);
    if (newContent !== null && newContent.trim()) {
      await this.plugin.updateCardContent(card.file, newContent);
      await this.refreshCards();
      new Notice("✏️ 已更新");
    }
  }

  toggleSelectMode() {
    this.isSelectMode = !this.isSelectMode;
    if (!this.isSelectMode) {
      this.selectedIds.clear();
      new Notice("已退出选择模式");
    } else {
      new Notice("勾选卡片后点击「导出」批量导出");
    }
    this.renderCards();
  }

  async handleBatchExport() {
    if (!this.isSelectMode || this.selectedIds.size === 0) {
      this.isSelectMode = true;
      this.renderCards();
      new Notice("请先勾选要导出的卡片");
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

  private formatDate(timestamp: number): string {
    const d = new Date(timestamp);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}

// ─── 设置页 ────────────────────────────────────────────────────

class CardWaterfallSettingTab extends PluginSettingTab {
  plugin: CardWaterfallPlugin;

  constructor(app: App, plugin: CardWaterfallPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "灵感卡片瀑布流 - 设置" });

    new Setting(containerEl)
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

    new Setting(containerEl)
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
}
