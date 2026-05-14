import { Editor, TFile } from "obsidian";

export type FormattingContext =
  | {
      mode: "source";
      editor: Editor;
      file: TFile | null;
    }
  | {
      mode: "preview";
      editor: null;
      file: TFile;
      selection: string;
    };

export type FormattingContextProvider = () => FormattingContext | null;
