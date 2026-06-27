import {
  App, ItemView, Plugin, PluginSettingTab, Setting,
  WorkspaceLeaf, TFile, Notice, MarkdownRenderer,
  parseYaml, stringifyYaml,
} from "obsidian";

// ─── 配置 ───────────────────────────────────────────────────────
const VIEW_TYPE = "card-waterfall-view";

const STATUS_OPTIONS = ["默认", "短篇", "长篇", "归档", "其他"] as const;
type CardStatus = typeof STATUS_OPTIONS[number];

const STATUS_COLORS: Record<CardStatus, string> = {
  "默认": "",
  "短篇": "#D4E2D4",
  "长篇": "#D0D8E8",
  "归档": "#D8D8D8",
  "其他": "#E8DCC8",
};
const STATUS_LABELS: Record<CardStatus, string> = {
  "默认": "默认",
  "短篇": "短篇",
  "长篇": "长篇",
  "归档": "归档",
  "其他": "其他",
};
const STATUS_BADGE_COLORS: Record<CardStatus, string> = {
  "默认": "",
  "短篇": "#5A8F5A",
  "长篇": "#5A7FA8",
  "归档": "#888888",
  "其他": "#A08060",
};

interface CardWaterfallSettings {
  inspirationsFolder: string;
  cardColumns: number;
}

const DEFAULT_SETTINGS: CardWaterfallSettings = {
  inspirationsFolder: "灵感卡片",
  cardColumns: 3,
};

// ─── 卡片接口 ──────────────────────────────────────────────────
interface CardData {
  id: string; content: string; title: string;
  created: number; pinned: boolean;
  status: CardStatus; tags: string[]; file: TFile;
}

// ─── 标签颜色映射 ──────────────────────────────────────────────
// 高饱和度标签圆点颜色（用户要求用高饱和不同颜色区分标签）
const TAG_DOT_COLORS = [
  "#FF6B6B", "#FFA94D", "#FFD43B", "#69DB7C", "#4DABF7",
  "#748FFC", "#DA77F2", "#F783AC", "#20C997", "#FF8787",
  "#A9E34B", "#339AF0", "#845EF7", "#E8590C", "#F06595",
];

function getTagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  return TAG_DOT_COLORS[Math.abs(hash) % TAG_DOT_COLORS.length];
}

// ─── 工具函数 ──────────────────────────────────────────────────
function extractTitle(content: string): string {
  const lines = content.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return "无标题";
  let title = lines[0];
  title = title.replace(/^#+\s+/, "");
  title = title.replace(/\*\*/g, "").replace(/\*/g, "");
  title = title.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  title = title.replace(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)+\s*/u, "");
  title = title.replace(/\p{Emoji_Presentation}|\p{Emoji}\uFE0F/gu, "");
  if (title.length > 16) title = title.slice(0, 16) + "…";
  return title.trim() || "无标题";
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim() || "未命名";
}

// ─── 主插件 ────────────────────────────────────────────────────
export default class CardWaterfallPlugin extends Plugin {
  settings: CardWaterfallSettings;

  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new CardWaterfallView(leaf, this));
    this.addRibbonIcon("layers-3", "打开灵感卡片瀑布流", () => this.activateView());
    this.addCommand({ id: "open-card-waterfall", name: "打开灵感卡片瀑布流", callback: () => this.activateView() });
    this.addSettingTab(new CardWaterfallSettingTab(this.app, this));
    if (this.app.workspace.getLeavesOfType(VIEW_TYPE).length === 0) await this.activateView();
  }

  async onunload() { this.app.workspace.detachLeavesOfType(VIEW_TYPE); }
  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length > 0) leaf = leaves[0];
    else { leaf = workspace.getRightLeaf(false); if (leaf) await leaf.setViewState({ type: VIEW_TYPE, active: true }); }
    if (leaf) workspace.revealLeaf(leaf);
  }

  parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (match) {
      try { return { frontmatter: parseYaml(match[1]) || {}, body: match[2].trim() }; }
      catch { return { frontmatter: {}, body: content }; }
    }
    return { frontmatter: {}, body: content.trim() };
  }

  async loadCards(): Promise<CardData[]> {
    const folder = this.app.vault.getAbstractFileByPath(this.settings.inspirationsFolder);
    if (!folder) return [];
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(this.settings.inspirationsFolder + "/") && f.extension === "md");
    const cards: CardData[] = [];
    for (const file of files) {
      const raw = await this.app.vault.read(file);
      const { frontmatter, body } = this.parseFrontmatter(raw);
      const status = (frontmatter.status as string) || "默认";
      cards.push({
        id: file.basename, content: body || "(空灵感)",
        title: (frontmatter.title as string) || extractTitle(body || ""),
        created: frontmatter.created ? new Date(frontmatter.created as string).getTime() : file.stat.ctime,
        pinned: frontmatter.pinned === true,
        status: STATUS_OPTIONS.includes(status as CardStatus) ? (status as CardStatus) : "默认",
        tags: (frontmatter.tags as string[]) || [],
        file,
      });
    }
    cards.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return b.created - a.created;
    });
    return cards;
  }

  async createCard(content: string, tags: string[] = []): Promise<void> {
    const now = new Date();
    const title = extractTitle(content);
    const safeName = sanitizeFilename(title);
    const pad2 = (n: number) => n.toString().padStart(2, "0");
    const tp = `${pad2(now.getMonth() + 1)}${pad2(now.getDate())}_${pad2(now.getHours())}${pad2(now.getMinutes())}`;
    const fp = `${this.settings.inspirationsFolder}/${tp}_${safeName}.md`;
    const f = this.app.vault.getAbstractFileByPath(this.settings.inspirationsFolder);
    if (!f) await this.app.vault.createFolder(this.settings.inspirationsFolder);
    await this.app.vault.create(fp, `---\n${stringifyYaml({ created: now.toISOString(), title, pinned: false, status: "默认", tags })}---\n\n${content.trim()}\n`);
    new Notice("✅ 灵感已记录");
  }

  async setStatus(file: TFile, status: CardStatus): Promise<void> {
    const raw = await this.app.vault.read(file);
    const { frontmatter, body } = this.parseFrontmatter(raw);
    frontmatter.status = status;
    await this.app.vault.modify(file, `---\n${stringifyYaml(frontmatter)}---\n\n${body}\n`);
  }

  async togglePin(file: TFile): Promise<void> {
    const raw = await this.app.vault.read(file);
    const { frontmatter, body } = this.parseFrontmatter(raw);
    frontmatter.pinned = !frontmatter.pinned;
    await this.app.vault.modify(file, `---\n${stringifyYaml(frontmatter)}---\n\n${body}\n`);
  }

  async updateCardContent(file: TFile, newBody: string): Promise<void> {
    const raw = await this.app.vault.read(file);
    const { frontmatter } = this.parseFrontmatter(raw);
    frontmatter.title = extractTitle(newBody);
    await this.app.vault.modify(file, `---\n${stringifyYaml(frontmatter)}---\n\n${newBody.trim()}\n`);
  }

  async deleteCard(file: TFile): Promise<void> { await this.app.vault.delete(file); new Notice("🗑️ 灵感已删除"); }

  async batchExport(files: TFile[]): Promise<void> {
    if (files.length === 0) { new Notice("请先选择要导出的卡片"); return; }
    const lines: string[] = ["# 灵感导出\n"];
    const sorted = [...files].sort((a, b) => a.stat.ctime - b.stat.ctime);
    for (const file of sorted) {
      const raw = await this.app.vault.read(file);
      const { frontmatter, body } = this.parseFrontmatter(raw);
      const date = frontmatter.created ? new Date(frontmatter.created as string).toLocaleString("zh-CN") : "未知";
      lines.push(`## ${(frontmatter.title as string) || file.basename}`);
      lines.push(`> 时间：${date}`);
      if (frontmatter.pinned) lines.push("> 🔖 已置顶");
      lines.push(""); lines.push(body); lines.push(""); lines.push("---"); lines.push("");
    }
    await this.app.vault.create(`灵感导出_${this.formatTimestamp(new Date())}.md`, lines.join("\n"));
    new Notice(`✅ 已导出 ${files.length} 条灵感`);
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
  searchQuery: string = "";
  statusFilter: CardStatus | "全部" = "全部";

  // DOM
  containerEl: HTMLElement;
  searchInputEl: HTMLInputElement;
  gridEl: HTMLElement;
  emptyStateEl: HTMLElement;
  inputAreaEl: HTMLElement;
  cardInputEl: HTMLTextAreaElement;
  toolbarEl: HTMLElement;
  statusBarEl: HTMLElement;
  statusBtns: Map<string, HTMLButtonElement> = new Map();
  cardElements: Map<string, HTMLElement> = new Map();
  // 发布弹窗
  modalOverlay: HTMLElement;
  modalInputEl: HTMLTextAreaElement;
  modalTagInput: HTMLInputElement;

  constructor(leaf: WorkspaceLeaf, plugin: CardWaterfallPlugin) { super(leaf); this.plugin = plugin; }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "灵感卡片瀑布流"; }
  getIcon(): string { return "layers-3"; }

  async onOpen() { this.buildUI(); await this.refreshCards(); }

  buildUI() {
    const c = this.containerEl;
    c.empty(); c.addClass("card-waterfall-container");
    const tb = c.createDiv({ cls: "card-waterfall-topbar" });
    tb.createEl("h3", { text: "💡 灵感瀑布流", cls: "card-waterfall-title" });

    // ─── 搜索框（缩小对齐状态按钮） ───
    this.searchInputEl = tb.createEl("input", { type: "text", placeholder: "搜索", cls: "card-waterfall-search" });
    this.searchInputEl.addEventListener("input", () => { this.searchQuery = this.searchInputEl.value; this.renderCards(); });

    // ─── 工具栏 + 添加按钮 ───
    this.toolbarEl = tb.createDiv({ cls: "card-waterfall-toolbar" });
    const addBtn = this.toolbarEl.createEl("button", { text: "+", cls: "card-add-btn" });
    addBtn.addEventListener("click", () => this.showAddModal());
    const selectBtn = this.toolbarEl.createEl("button", { text: "选择", cls: "card-waterfall-btn" });
    selectBtn.addEventListener("click", () => this.toggleSelectMode());
    const exportBtn = this.toolbarEl.createEl("button", { text: "导出", cls: "card-waterfall-btn" });
    exportBtn.addEventListener("click", () => this.handleBatchExport());
    const refreshBtn = this.toolbarEl.createEl("button", { text: "刷新", cls: "card-waterfall-btn" });
    refreshBtn.addEventListener("click", () => this.refreshCards());

    // ─── 状态筛选栏 ───
    this.statusBarEl = c.createDiv({ cls: "card-status-bar" });
    this.buildStatusFilter();

    this.gridEl = c.createDiv({ cls: "card-waterfall-grid" });
    this.emptyStateEl = c.createDiv({ cls: "card-waterfall-empty" });
    this.emptyStateEl.innerHTML = `<div class="empty-icon">✨</div><div class="empty-text">还没有灵感，写下你的第一条灵感吧！</div>`;

    // ─── 发布弹窗（隐藏，点击 + 按钮时显示） ───
    this.modalOverlay = c.createDiv({ cls: "card-modal-overlay", attr: { style: "display:none;" } });
    const modal = this.modalOverlay.createDiv({ cls: "card-modal" });
    modal.createEl("h3", { text: "📝 发布灵感", cls: "card-modal-title" });
    this.modalInputEl = modal.createEl("textarea", { placeholder: "记录你的灵感...（支持 Markdown 格式）", cls: "card-waterfall-input", attr: { rows: "4" } });
    const tagRow = modal.createDiv({ cls: "card-input-tag-row" });
    this.modalTagInput = tagRow.createEl("input", { type: "text", placeholder: "标签（可选，逗号分隔）", cls: "card-input-tags" });
    const btnRow = modal.createDiv({ cls: "card-modal-btns" });
    const cancelBtn = btnRow.createEl("button", { text: "取消", cls: "card-modal-cancel" });
    cancelBtn.addEventListener("click", () => this.hideAddModal());
    const pubBtn = btnRow.createEl("button", { text: "发布 💡", cls: "card-modal-submit" });
    pubBtn.addEventListener("click", () => this.handleAddSubmit());

    // 回车发布
    this.modalInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.handleAddSubmit(); }
    });

    // 点击遮罩关闭
    this.modalOverlay.addEventListener("click", (e) => { if (e.target === this.modalOverlay) this.hideAddModal(); });
  }

  buildStatusFilter() {
    this.statusBarEl.empty();
    this.statusBtns.clear();
    const allBtn = this.statusBarEl.createEl("button", { text: "全部", cls: "card-status-filter active" });
    allBtn.addEventListener("click", () => { this.statusFilter = "全部"; this.updateStatusFilterUI(); this.renderCards(); });
    this.statusBtns.set("全部", allBtn);

    for (const s of STATUS_OPTIONS) {
      const btn = this.statusBarEl.createEl("button", { text: STATUS_LABELS[s], cls: "card-status-filter" });
      btn.addEventListener("click", () => { this.statusFilter = s; this.updateStatusFilterUI(); this.renderCards(); });
      this.statusBtns.set(s, btn);
    }
  }

  updateStatusFilterUI() {
    for (const [k, v] of this.statusBtns) {
      v.removeClass("active");
      if (k === this.statusFilter) v.addClass("active");
    }
  }

  async handleAddSubmit() {
    const text = this.modalInputEl.value.trim();
    if (!text) { new Notice("请输入灵感内容"); return; }
    const tags = this.modalTagInput.value.split(/[,，、\s]+/).map((t) => t.trim()).filter((t) => t.length > 0);
    await this.plugin.createCard(text, tags);
    this.modalInputEl.value = "";
    this.modalTagInput.value = "";
    this.hideAddModal();
    await this.refreshCards();
  }

  showAddModal() {
    this.modalOverlay.style.display = "flex";
    this.modalInputEl.value = "";
    this.modalTagInput.value = "";
    setTimeout(() => this.modalInputEl.focus(), 50);
  }

  hideAddModal() {
    this.modalOverlay.style.display = "none";
  }

  refreshCards() { this.plugin.loadCards().then((c) => { this.cards = c; this.renderCards(); }); }

  setCardStatus(card: CardData, newStatus: CardStatus) {
    this.plugin.setStatus(card.file, newStatus);
    card.status = newStatus;
    this.updateCardElement(card);
  }

  updateCardElement(card: CardData) {
    const el = this.cardElements.get(card.id);
    if (!el) { this.renderCards(); return; }

    // 更新背景色
    const bgColor = STATUS_COLORS[card.status] || null;
    if (bgColor) {
      el.style.backgroundColor = bgColor;
      el.style.borderColor = "transparent";
      el.style.opacity = card.status === "归档" ? "0.7" : "";
    } else {
      el.style.backgroundColor = "";
      el.style.borderColor = "";
      el.style.opacity = "";
    }

    // 更新状态徽章
    const oldBadge = el.querySelector(".card-status-badge");
    if (card.status !== "默认") {
      if (!oldBadge) {
        // 在标题后面插入新徽章
        const titleEl = el.querySelector(".card-title");
        if (titleEl) {
          const stBadge = el.createDiv({ cls: "card-status-badge" });
          stBadge.textContent = STATUS_LABELS[card.status];
          stBadge.style.backgroundColor = "rgba(255,255,255,0.6)";
          stBadge.style.color = STATUS_BADGE_COLORS[card.status] || "#666";
          stBadge.style.border = "1px solid rgba(0,0,0,0.08)";
          titleEl.after(stBadge);
        }
      } else {
        (oldBadge as HTMLElement).textContent = STATUS_LABELS[card.status];
        (oldBadge as HTMLElement).style.color = STATUS_BADGE_COLORS[card.status] || "#666";
      }
    } else {
      if (oldBadge) oldBadge.remove();
    }

    // 更新置顶状态按钮文字
    const statusBtn = el.querySelector(".card-status-btn") as HTMLButtonElement;
    if (statusBtn) {
      statusBtn.textContent = STATUS_LABELS[card.status];
      if (STATUS_BADGE_COLORS[card.status]) statusBtn.style.color = STATUS_BADGE_COLORS[card.status];
      else statusBtn.style.color = "";
    }
  }

  renderCards() {
    this.gridEl.empty();
    const query = this.searchQuery.toLowerCase().trim();
    let filtered = this.cards;

    // 按状态过滤
    if (this.statusFilter !== "全部") {
      filtered = filtered.filter((c) => c.status === this.statusFilter);
    }

    // 搜索
    if (query) {
      filtered = filtered.filter(
        (c) => c.content.toLowerCase().includes(query) || c.title.toLowerCase().includes(query) || c.tags.some((t) => t.toLowerCase().includes(query))
      );
    }

    if (filtered.length === 0) {
      this.gridEl.style.display = "none";
      this.emptyStateEl.innerHTML = `<div class="empty-icon">📭</div><div class="empty-text">没有匹配的灵感</div>`;
      this.emptyStateEl.style.display = "flex"; return;
    }

    this.gridEl.style.display = ""; this.emptyStateEl.style.display = "none";
    this.cardElements.clear();

    // 计算列宽
    const columns = this.plugin.settings.cardColumns || 3;
    const gap = 18;
    const gridWidth = this.gridEl.clientWidth;
    const colWidth = Math.max(100, (gridWidth - gap * (columns - 1)) / columns);
    this.gridEl.style.position = "";
    this.gridEl.style.height = "";

    for (const card of filtered) {
      const uniqueTags = [...new Set(card.tags)];
      const bgColor = STATUS_COLORS[card.status] || null;

      const cardEl = this.gridEl.createDiv({ cls: "card-waterfall-card", attr: { "data-id": card.id } });
      this.cardElements.set(card.id, cardEl);

      // ✅ 在文档流中设好卡片宽度 + 垂直间距
      cardEl.style.width = colWidth + "px";
      cardEl.style.marginBottom = gap + "px";

      if (bgColor) {
        cardEl.style.backgroundColor = bgColor;
        cardEl.style.borderColor = "transparent";
      }

      if (card.status === "归档") {
        cardEl.style.opacity = "0.7";
      }

      if (this.selectedIds.has(card.id)) cardEl.addClass("is-selected");
      if (card.pinned) cardEl.addClass("is-pinned");

      cardEl.addEventListener("click", async () => {
        if (this.isSelectMode) return;
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(card.file, { state: { mode: "source" } });
      });

      // 头部
      const header = cardEl.createDiv({ cls: "card-header" });
      if (card.pinned) header.createSpan({ text: "📌 已置顶", cls: "card-pin-badge" });
      if (uniqueTags.length > 0) {
        const tagDots = header.createSpan({ cls: "card-tag-dots" });
        for (const tag of uniqueTags) { const d = tagDots.createSpan({ cls: "card-tag-dot", attr: { title: tag } }); d.style.backgroundColor = getTagColor(tag); }
      }
      header.createSpan({ cls: "card-time", text: this.formatDate(card.created) });

      // 标题
      const titleEl = cardEl.createDiv({ cls: "card-title" });
      titleEl.textContent = card.title;

      // 正文（异步渲染）
      const body = cardEl.createDiv({ cls: "card-body" });
      let bodyContent = card.content.replace(/^#{1,3}\s+.*(\n|$)/, "").trim();
      const MAX_LEN = 500;
      let isTruncated = false;
      if (bodyContent.length > MAX_LEN) { bodyContent = bodyContent.slice(0, MAX_LEN); isTruncated = true; }
      MarkdownRenderer.render(this.app, bodyContent || card.content, body, card.file.path, this.plugin);
      if (isTruncated) body.createEl("div", { cls: "card-expand-hint", text: "… 点击卡片展开查看完整内容" });

      // 操作区
      const actions = cardEl.createDiv({ cls: "card-actions" });

      if (this.isSelectMode) {
        const cb = actions.createEl("input", { type: "checkbox", cls: "card-checkbox" });
        cb.checked = this.selectedIds.has(card.id);
        cb.addEventListener("change", (e) => {
          e.stopPropagation();
          if (cb.checked) { this.selectedIds.add(card.id); cardEl.addClass("is-selected"); }
          else { this.selectedIds.delete(card.id); cardEl.removeClass("is-selected"); }
        });
      } else {
        const pinBtn = actions.createEl("button", { text: card.pinned ? "取消置顶" : "置顶", cls: "card-action-btn" });
        pinBtn.addEventListener("click", async (e) => { e.stopPropagation(); await this.plugin.togglePin(card.file); await this.refreshCards(); });

        const currentStatus = card.status;
        const statusBtn = actions.createEl("button", { text: STATUS_LABELS[currentStatus], cls: "card-action-btn card-status-btn" });
        if (STATUS_BADGE_COLORS[currentStatus]) statusBtn.style.color = STATUS_BADGE_COLORS[currentStatus];
        statusBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          this.showStatusMenu(card, statusBtn);
        });

        const delBtn = actions.createEl("button", { text: "删除", cls: "card-action-btn card-action-danger" });
        delBtn.addEventListener("click", async (e) => { e.stopPropagation(); if (confirm(`确定删除「${card.title}」？`)) { await this.plugin.deleteCard(card.file); await this.refreshCards(); } });
      }
    }

    // ⏳ 等 DOM 渲染稳定后再做 Masonry 定位
    setTimeout(() => this.layoutMasonry(), 120);
  }

  // ─── Masonry 布局：最短列算法 ───
  layoutMasonry() {
    const cards = Array.from(this.gridEl.children) as HTMLElement[];
    if (cards.length === 0) return;

    const columns = this.plugin.settings.cardColumns || 3;
    const gap = 18;
    const colWidth = parseFloat(cards[0]?.style.width) || 280;

    // 读取自然高度（卡片此时还在文档流中，绝对定位还没设）
    const heights = cards.map((el) => el.offsetHeight);

    // 最短列算法
    const colHeights = new Array(columns).fill(-gap);
    this.gridEl.style.position = "relative";

    for (let i = 0; i < cards.length; i++) {
      let minCol = 0;
      for (let j = 1; j < columns; j++) {
        if (colHeights[j] < colHeights[minCol]) minCol = j;
      }
      cards[i].style.position = "absolute";
      cards[i].style.width = colWidth + "px";
      cards[i].style.left = (minCol * (colWidth + gap)) + "px";
      cards[i].style.top = (colHeights[minCol] + gap) + "px";
      cards[i].style.marginBottom = "0";
      colHeights[minCol] += heights[i] + gap;
    }

    // 容器高度 = 最长列
    this.gridEl.style.height = Math.max(200, Math.max(...colHeights)) + "px";
  }

  showStatusMenu(card: CardData, anchor: HTMLButtonElement) {
    // 移除已有菜单
    document.querySelectorAll(".card-status-menu").forEach((el) => el.remove());

    const menu = anchor.createDiv({ cls: "card-status-menu" });
    menu.style.position = "absolute";
    menu.style.bottom = "100%";
    menu.style.left = "0";
    menu.style.zIndex = "100";
    menu.style.background = "var(--background-primary)";
    menu.style.border = "1px solid var(--background-modifier-border)";
    menu.style.borderRadius = "8px";
    menu.style.padding = "4px";
    menu.style.boxShadow = "0 4px 12px rgba(0,0,0,0.12)";
    menu.style.minWidth = "90px";

    for (const s of STATUS_OPTIONS) {
      const item = menu.createEl("button", { text: STATUS_LABELS[s], cls: "card-status-menu-item" });
      item.style.display = "block";
      item.style.width = "100%";
      item.style.padding = "6px 12px";
      item.style.border = "none";
      item.style.borderRadius = "4px";
      item.style.background = "transparent";
      item.style.cursor = "pointer";
      item.style.textAlign = "left";
      item.style.fontSize = "12px";
      if (STATUS_BADGE_COLORS[s]) item.style.color = STATUS_BADGE_COLORS[s];
      if (s === card.status) item.style.fontWeight = "bold";
      item.addEventListener("mouseenter", () => { item.style.background = "var(--background-modifier-hover)"; });
      item.addEventListener("mouseleave", () => { item.style.background = "transparent"; });
      item.addEventListener("click", async (e) => {
        e.stopPropagation();
        card.status = s;
        await this.plugin.setStatus(card.file, s);
        this.updateCardElement(card);
        menu.remove();
      });
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
    if (!this.isSelectMode) { this.selectedIds.clear(); new Notice("已退出选择模式"); }
    else { new Notice("勾选卡片后点击「导出」批量导出"); }
    this.renderCards();
  }

  async handleBatchExport() {
    if (!this.isSelectMode || this.selectedIds.size === 0) {
      this.isSelectMode = true; this.renderCards(); new Notice("请先勾选要导出的卡片"); return;
    }
    const sf = this.cards.filter((c) => this.selectedIds.has(c.id)).map((c) => c.file);
    await this.plugin.batchExport(sf);
    this.isSelectMode = false; this.selectedIds.clear(); this.renderCards();
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
  constructor(app: App, plugin: CardWaterfallPlugin) { super(app, plugin); this.plugin = plugin; }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "灵感卡片瀑布流 - 设置" });

    new Setting(containerEl).setName("灵感卡片存储文件夹").setDesc("每条灵感将作为单独的 Markdown 文件存储在此文件夹中")
      .addText((text) => text.setPlaceholder("灵感卡片").setValue(this.plugin.settings.inspirationsFolder)
        .onChange(async (value) => { this.plugin.settings.inspirationsFolder = value || "灵感卡片"; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("卡片列数").setDesc("瀑布流显示的列数（桌面端推荐 3-4 列）")
      .addSlider((slider) => slider.setLimits(1, 6, 1).setValue(this.plugin.settings.cardColumns).setDynamicTooltip()
        .onChange(async (value) => { this.plugin.settings.cardColumns = value; await this.plugin.saveSettings(); document.documentElement.style.setProperty("--card-waterfall-columns", value.toString()); }));
  }
}
