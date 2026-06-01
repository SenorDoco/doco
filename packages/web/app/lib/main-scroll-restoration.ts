export type MainScrollNavigationType = "POP" | "PUSH" | "REPLACE";

export type MainScrollElement = {
  scrollLeft: number;
  scrollTop: number;
};

type ScrollPosition = {
  left: number;
  top: number;
};

export type MainScrollNavigation = {
  element: MainScrollElement;
  key: string;
  navigationType: MainScrollNavigationType;
};

export function createMainScrollRestorer() {
  return new MainScrollRestorer();
}

class MainScrollRestorer {
  private activeKey: string | null = null;
  private readonly positions = new Map<string, ScrollPosition>();

  applyNavigation({ element, key, navigationType }: MainScrollNavigation) {
    if (this.activeKey && this.activeKey !== key) {
      this.save(this.activeKey, element);
    }

    this.activeKey = key;

    if (navigationType === "POP") {
      const position = this.positions.get(key);
      if (position) {
        applyPosition(element, position);
      }
      return;
    }

    applyPosition(element, { left: 0, top: 0 });
  }

  saveCurrent(element: MainScrollElement) {
    if (!this.activeKey) return;
    this.save(this.activeKey, element);
  }

  private save(key: string, element: MainScrollElement) {
    this.positions.set(key, { left: element.scrollLeft, top: element.scrollTop });
  }
}

function applyPosition(element: MainScrollElement, position: ScrollPosition) {
  element.scrollLeft = position.left;
  element.scrollTop = position.top;
}
