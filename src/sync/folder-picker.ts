/** 打开系统目录选择对话框；返回绝对路径（统一 / 分隔符），取消返回 null */
export async function pickDirectory(): Promise<string | null> {
  try {
    const win = window as any;
    if (win.require) {
      const electron = win.require("electron");
      const properties = ["openDirectory", "createDirectory"];
      if (electron.remote && electron.remote.dialog) {
        const result = await electron.remote.dialog.showOpenDialog({ properties });
        return result.filePaths?.[0]?.replace(/\\/g, "/") ?? null;
      }
      if (electron.ipcRenderer && electron.ipcRenderer.invoke) {
        const result = await electron.ipcRenderer.invoke("show-open-dialog", { properties });
        return result.filePaths?.[0]?.replace(/\\/g, "/") ?? null;
      }
    }
  } catch (error) {
    console.warn("Note Bar 目录选择失败:", error);
  }
  return null;
}
