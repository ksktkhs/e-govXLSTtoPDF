import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

type SourceType = "zip" | "folder" | "direct";

type SourceInfo = {
  sourceIndex: number;
  sourceType: SourceType;
  sourceName: string;
  folderName?: string | null;
};

type FilePair = {
  key: string;
  basename: string;
  xml: File;
  xsl: File;
  title?: string;
  jigyoushoName?: string;
  sourceInfo?: SourceInfo;
};

type PreviewState = {
  html: string;
  landscape: boolean;
  pair?: FilePair;
};

const decompressZip = async (arrayBuffer: ArrayBuffer) => {
  const decompressData = async (compressedData: ArrayBuffer) => {
    const reader = new Blob([compressedData])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"))
      .getReader();

    const chunks: BlobPart[] = [];
    let result = await reader.read();
    while (!result.done) {
      const chunk = result.value;
      chunks.push(
        chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
      );
      result = await reader.read();
    }
    return new Blob(chunks);
  };

  const dataView = new DataView(arrayBuffer);
  let offset = 0;
  const files: File[] = [];

  while (offset < dataView.byteLength) {
    const signature = dataView.getUint32(offset, true);
    if (signature !== 0x04034b50) break;

    const generalPurposeFlag = dataView.getUint16(offset + 6, true);
    const fileNameLength = dataView.getUint16(offset + 26, true);
    const extraFieldLength = dataView.getUint16(offset + 28, true);
    let compressedSize = dataView.getUint32(offset + 18, true);

    const pathName = new TextDecoder().decode(
      arrayBuffer.slice(offset + 30, offset + 30 + fileNameLength)
    );
    offset += fileNameLength + extraFieldLength + 30;
    const dataOffset = offset;
    const isDataDescriptor = (generalPurposeFlag & 0x0008) !== 0;

    if (isDataDescriptor) {
      while (offset < dataView.byteLength) {
        const potentialSignature = dataView.getUint32(offset, true);
        if (potentialSignature === 0x08074b50) {
          compressedSize = dataView.getUint32(offset + 8, true);
          offset += 16;
          break;
        }
        offset++;
      }
    } else {
      offset += compressedSize;
    }

    if (!pathName.endsWith("/")) {
      const decompressedData = await decompressData(
        arrayBuffer.slice(dataOffset, dataOffset + compressedSize)
      );
      const fileName = pathName.replace(/.*\//, "");
      files.push(new File([decompressedData], fileName));
    }
  }
  return files;
};

const applyTextFormatting = (contents: HTMLElement) => {
  const formatBlock = (selector: string, lineLength: number) => {
    const elements = contents.querySelectorAll(selector);
    elements.forEach((pre) => {
      const originalText = pre.textContent ?? "";
      const cleanText = originalText
        .replace(/[\r\n\t]/g, "")
        .replace(/ /g, "");

      let newText = "";
      let charCount = 0;

      for (let i = 0; i < cleanText.length; i++) {
        const char = cleanText[i];
        newText += char;

        const charCode = char.charCodeAt(0);
        const isFullWidth = charCode > 0x7f;
        charCount += isFullWidth ? 1 : 0.5;

        if (charCount >= lineLength && i < cleanText.length - 1) {
          newText += "\n";
          charCount = 0;
        }
      }
      pre.textContent = newText;
    });
  };

  formatBlock("pre.oshirase", 26);
  formatBlock("pre.kyouji", 48);

  const tables = contents.querySelectorAll("table");
  tables.forEach((table) => {
    const cells = table.querySelectorAll("td, th");
    cells.forEach((cell) => {
      const text = cell.textContent?.trim();
      if (text === "届出年月日") {
        cell.setAttribute("style", "text-align: center;");
      }
    });
  });
};

const extractOrganizationName = (xmlDoc: Document) => {
  const keywords = ["事業所名", "事業者名", "法人名"];
  const allElements = Array.from(xmlDoc.getElementsByTagName("*"));

  const matchedElement = allElements.find((elem) => {
    const local = elem.localName || "";
    const node = elem.nodeName || "";
    return keywords.some(
      (word) => local.includes(word) || node.includes(word)
    );
  });

  return matchedElement?.textContent?.trim() ?? "";
};

const convertToHtml = async (xmlFile: File, xslFile: File) => {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(await xmlFile.text(), "application/xml");
  const xslDoc = parser.parseFromString(await xslFile.text(), "application/xml");

  const processor = new XSLTProcessor();
  processor.importStylesheet(xslDoc);
  const resultDoc = processor.transformToDocument(xmlDoc);
  const serializer = new XMLSerializer();

  const container = document.createElement("div");
  container.innerHTML = serializer.serializeToString(resultDoc);
  applyTextFormatting(container);
  return container.innerHTML;
};

const formatSize = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

const App: React.FC = () => {
  const [filePairs, setFilePairs] = useState<FilePair[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ html: "", landscape: false });
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const xslCache = useRef<Map<string, { file: File; title: string }>>(new Map());
  const xmlPool = useRef<
    Map<
      string,
      Array<{
        file: File;
        jigyoushoName?: string;
        sourceInfo: SourceInfo;
      }>
    >
  >(new Map());
  const processedFileKeys = useRef<Set<string>>(new Set());
  const counterRef = useRef(1);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute("webkitdirectory", "true");
      folderInputRef.current.setAttribute("directory", "true");
    }
  }, []);

  const resetAll = useCallback(() => {
    setFilePairs([]);
    setSelectedKey(null);
    setPreview({ html: "", landscape: false });
    xslCache.current.clear();
    xmlPool.current.clear();
    processedFileKeys.current.clear();
    counterRef.current = 1;
  }, []);

  const collectFilesFromEntries = useCallback(
    async (items: DataTransferItemList) => {
      const readEntry = async (entry: any, path = ""): Promise<File[]> => {
        if (entry.isFile) {
          return new Promise((resolve) => {
            entry.file(
              (file: File) => {
                if (path) {
                  Object.defineProperty(file, "webkitRelativePath", {
                    value: `${path}${entry.name}`,
                    writable: false,
                  });
                }
                resolve([file]);
              },
              () => resolve([]),
            );
          });
        }

        if (entry.isDirectory) {
          const dirReader = entry.createReader();
          const entries: any[] = [];

          const readAll = async (): Promise<any[]> =>
            new Promise((resolve) => {
              const readBatch = () => {
                dirReader.readEntries(
                  async (batch: any[]) => {
                    if (batch.length === 0) {
                      resolve(entries);
                    } else {
                      entries.push(...batch);
                      readBatch();
                    }
                  },
                  () => resolve(entries),
                );
              };
              readBatch();
            });

          const subEntries = await readAll();
          const nestedFiles = await Promise.all(
            subEntries.map((subEntry) => readEntry(subEntry, `${path}${entry.name}/`)),
          );
          return nestedFiles.flat();
        }

        return [];
      };

      const promises: Promise<File[]>[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === "file") {
          const entry = (item as any).webkitGetAsEntry?.();
          if (entry) {
            promises.push(readEntry(entry));
          } else {
            const file = item.getAsFile();
            if (file) promises.push(Promise.resolve([file]));
          }
        }
      }

      const results = await Promise.all(promises);
      return results.flat();
    },
    [],
  );

  const addFilesToStorage = useCallback(
    async (files: File[]) => {
      setError(null);
      const processedFiles: Array<{
        file: File;
        sourceIndex: number;
        sourceType: SourceType;
        sourceName: string;
        folderName?: string | null;
      }> = [];

      const extractFolderName = (file: File) => {
        if ((file as any).webkitRelativePath) {
          const parts = (file as any).webkitRelativePath.split("/");
          return parts.length > 1 ? parts[0] : null;
        }
        return null;
      };

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const folderName = extractFolderName(file);
        const fileKey = `${(file as any).webkitRelativePath || file.name}_${file.size}_${file.lastModified}`;

        if (processedFileKeys.current.has(fileKey)) continue;
        processedFileKeys.current.add(fileKey);

        if (
          file.type.match(/^application\/(x-zip-compressed|zip)$/) ||
          file.name.toLowerCase().endsWith(".zip")
        ) {
          const unzipped = await file.arrayBuffer().then(decompressZip);
          unzipped.forEach((unzippedFile) => {
            processedFiles.push({
              file: unzippedFile,
              sourceIndex: i,
              sourceType: "zip",
              sourceName: file.name,
              folderName,
            });
          });
        } else {
          processedFiles.push({
            file,
            sourceIndex: i,
            sourceType: folderName ? "folder" : "direct",
            sourceName: file.name,
            folderName,
          });
        }
      }

      const xmlFiles: typeof processedFiles = [];
      const xslFiles: typeof processedFiles = [];

      processedFiles.forEach((item) => {
        if (item.file.name.toLowerCase().endsWith(".xml")) {
          xmlFiles.push(item);
        } else if (item.file.name.toLowerCase().endsWith(".xsl")) {
          xslFiles.push(item);
        }
      });

      const newXslBasenames: string[] = [];
      for (const { file } of xslFiles) {
        const basename = file.name.replace(/\.xsl$/i, "");
        const parser = new DOMParser();
        const xslDoc = parser.parseFromString(await file.text(), "application/xml");
        const titleElement = xslDoc.querySelector("title");
        const title = titleElement ? titleElement.textContent?.trim() ?? "" : "";
        xslCache.current.set(basename, { file, title });
        newXslBasenames.push(basename);
      }

      const newPairs: FilePair[] = [];
      for (const { file: xmlFile, sourceIndex, sourceType, sourceName, folderName } of xmlFiles) {
        const basename = xmlFile.name.replace(/\.xml$/i, "");
        const xslData = xslCache.current.get(basename);

        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(await xmlFile.text(), "application/xml");
        const jigyoushoName = extractOrganizationName(xmlDoc);

        if (xslData) {
          const uniqueKey = `${basename}_${counterRef.current++}_${Date.now()}`;
          newPairs.push({
            key: uniqueKey,
            basename,
            xml: xmlFile,
            xsl: xslData.file,
            title: xslData.title,
            jigyoushoName,
            sourceInfo: {
              sourceIndex,
              sourceType,
              sourceName,
              folderName,
            },
          });
        } else {
          if (!xmlPool.current.has(basename)) {
            xmlPool.current.set(basename, []);
          }
          xmlPool.current.get(basename)?.push({
            file: xmlFile,
            jigyoushoName,
            sourceInfo: { sourceIndex, sourceType, sourceName, folderName },
          });
        }
      }

      newXslBasenames.forEach((basename) => {
        const pooledXmls = xmlPool.current.get(basename);
        if (pooledXmls && pooledXmls.length > 0) {
          const xslData = xslCache.current.get(basename);
          if (!xslData) return;
          pooledXmls.forEach(({ file: xmlFile, jigyoushoName, sourceInfo }) => {
            const uniqueKey = `${basename}_${counterRef.current++}_${Date.now()}`;
            newPairs.push({
              key: uniqueKey,
              basename,
              xml: xmlFile,
              xsl: xslData.file,
              title: xslData.title,
              jigyoushoName,
              sourceInfo,
            });
          });
          xmlPool.current.delete(basename);
        }
      });

      setFilePairs((prev) => {
        const updated = [...prev, ...newPairs];
        if (!selectedKey && updated.length > 0) {
          setSelectedKey(updated[0].key);
        }
        return updated;
      });
    },
    [selectedKey],
  );

  const handleFilesSelected = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      await addFilesToStorage(Array.from(files));
    },
    [addFilesToStorage],
  );

  const handleDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);

      const items = event.dataTransfer?.items;
      const collected = items ? await collectFilesFromEntries(items) : [];
      const fallback =
        collected.length === 0 && event.dataTransfer?.files?.length
          ? Array.from(event.dataTransfer.files)
          : [];

      const allFiles = [...collected, ...fallback];
      if (allFiles.length === 0) return;
      await addFilesToStorage(allFiles);
    },
    [addFilesToStorage, collectFilesFromEntries],
  );

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
  };

  const deletePair = useCallback(
    (key: string) => {
      setFilePairs((prev) => {
        const updated = prev.filter((pair) => pair.key !== key);
        if (selectedKey === key) {
          setSelectedKey(updated[0]?.key ?? null);
        }
        return updated;
      });
    },
    [selectedKey],
  );

  const loadPreview = useCallback(
    async (pair: FilePair | undefined) => {
      if (!pair) {
        setPreview({ html: "", landscape: false, pair });
        return;
      }
      setIsLoadingPreview(true);
      try {
        const html = await convertToHtml(pair.xml, pair.xsl);
        setPreview({
          html,
          landscape: pair.basename.startsWith("2"),
          pair,
        });
      } catch (err) {
        console.error(err);
        setError("プレビューの生成に失敗しました。XML/XSLの内容をご確認ください。");
      } finally {
        setIsLoadingPreview(false);
      }
    },
    [],
  );

  useEffect(() => {
    const current = filePairs.find((pair) => pair.key === selectedKey);
    loadPreview(current);
  }, [filePairs, selectedKey, loadPreview]);

  const sortedPairs = useMemo(
    () => filePairs.map((pair, index) => ({ ...pair, index: index + 1 })),
    [filePairs],
  );

  const selectedPair = useMemo(
    () => filePairs.find((pair) => pair.key === selectedKey),
    [filePairs, selectedKey],
  );

  const totalCount = filePairs.length;

  return (
    <div className="app-shell min-h-screen">
      <header className="border-b bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 md:px-8">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
              XML / XSL
            </p>
            <h1 className="text-xl font-bold text-slate-900">PDF 変換ビューア</h1>
            <p className="text-sm text-slate-500">ZIPもフォルダもドラッグ&ドロップでまとめて読み込み</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
              onClick={() => fileInputRef.current?.click()}
            >
              ファイルを追加
            </button>
            <button
              className="rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-slate-800"
              onClick={() => folderInputRef.current?.click()}
            >
              フォルダ追加
            </button>
            {filePairs.length > 0 && (
              <button
                className="rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-600 transition hover:bg-rose-100"
                onClick={resetAll}
              >
                全クリア
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 md:px-8">
        <div
          className={`relative mb-6 flex flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed px-6 py-8 transition ${
            isDragging ? "border-indigo-400 bg-indigo-50/70" : "border-slate-300 bg-white"
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="pointer-events-none absolute inset-0 select-none bg-gradient-to-br from-indigo-50 to-transparent" />
          <div className="relative flex flex-col items-center gap-3 text-center">
            <span className="rounded-full bg-indigo-100 px-3 py-1 text-xs font-semibold text-indigo-700">
              ドラッグ&ドロップ対応
            </span>
            <h2 className="text-2xl font-semibold text-slate-900">
              XML / XSL / ZIP / フォルダをここにドロップ
            </h2>
            <p className="max-w-3xl text-sm text-slate-600">
              ファイル名（拡張子を除いたベース名）が一致するXMLとXSLを自動でペアリングしてプレビューを作成します。
              ZIPはブラウザ内で展開、重複ファイルはスキップします。
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 shadow-sm transition hover:-translate-y-0.5 hover:shadow"
                onClick={() => fileInputRef.current?.click()}
              >
                ファイルを選択
              </button>
              <button
                className="rounded-lg border border-indigo-200 bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-indigo-700 hover:shadow"
                onClick={() => folderInputRef.current?.click()}
              >
                フォルダを選択
              </button>
              {totalCount > 0 && (
                <span className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white">
                  ペア数: {totalCount}
                </span>
              )}
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {error}
          </div>
        )}

        {filePairs.length === 0 ? (
          <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
            <h3 className="text-lg font-semibold text-slate-900">使い方</h3>
            <ol className="mt-3 space-y-2 text-sm text-slate-700">
              <li>
                XML / XSL / ZIP / フォルダをドロップ、または「ファイルを選択」「フォルダを選択」から追加。
              </li>
              <li>ベース名が一致するXMLとXSLを自動でペアリングします。</li>
              <li>一覧からファイルを選ぶと右側にプレビューが表示されます。</li>
              <li>「PDFとして保存」でそのまま印刷 / PDF 保存ができます。</li>
            </ol>
          </section>
        ) : (
          <section className="grid gap-4 lg:grid-cols-[360px_1fr]">
            <aside className="sidebar rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Pairs
                  </p>
                  <p className="text-lg font-semibold text-slate-900">読み込み済み {totalCount} 件</p>
                </div>
                <button
                  className="text-sm font-medium text-indigo-600 hover:text-indigo-700"
                  onClick={() => fileInputRef.current?.click()}
                >
                  追加
                </button>
              </div>

              <div className="mt-4 flex flex-col gap-2">
                {sortedPairs.map((pair) => {
                  const isActive = pair.key === selectedKey;
                  const displayTitle =
                    pair.title ||
                    pair.jigyoushoName ||
                    pair.basename ||
                    pair.xml.name.replace(/\.xml$/i, "");

                  return (
                    <div
                      key={pair.key}
                      className={`group rounded-xl border p-3 transition ${
                        isActive
                          ? "border-indigo-300 bg-indigo-50 shadow-sm"
                          : "border-slate-200 bg-white hover:-translate-y-0.5 hover:border-indigo-200 hover:bg-indigo-50/40 hover:shadow-sm"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            {pair.index} / {totalCount}
                          </p>
                          <button
                            className="text-left text-sm font-semibold text-slate-900 transition hover:text-indigo-700"
                            onClick={() => setSelectedKey(pair.key)}
                          >
                            {displayTitle}
                          </button>
                          {pair.jigyoushoName && (
                            <p className="mt-1 truncate text-xs text-slate-600">{pair.jigyoushoName}</p>
                          )}
                          <p className="mt-1 text-[11px] text-slate-500">
                            {pair.xml.name}（{formatSize(pair.xml.size)}） / {pair.xsl.name}（
                            {formatSize(pair.xsl.size)}）
                          </p>
                          {pair.sourceInfo && (
                            <p className="text-[11px] text-slate-400">
                              {pair.sourceInfo.sourceType === "zip" && `${pair.sourceInfo.sourceName} から展開`}
                              {pair.sourceInfo.sourceType === "folder" &&
                                pair.sourceInfo.folderName &&
                                `${pair.sourceInfo.folderName} フォルダから`}
                            </p>
                          )}
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <span
                            className={`rounded-full px-2 py-1 text-[10px] font-semibold ${
                              pair.basename.startsWith("2")
                                ? "bg-emerald-100 text-emerald-700"
                                : "bg-slate-100 text-slate-700"
                            }`}
                          >
                            {pair.basename}
                          </span>
                          <button
                            className="text-xs font-semibold text-rose-500 opacity-0 transition group-hover:opacity-100"
                            onClick={() => deletePair(pair.key)}
                          >
                            削除
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </aside>

            <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Preview</p>
                  <p className="text-lg font-semibold text-slate-900">
                    {selectedPair?.title || selectedPair?.basename || "プレビュー"}
                  </p>
                  {selectedPair?.jigyoushoName && (
                    <p className="text-sm text-slate-600">{selectedPair.jigyoushoName}</p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    className="non-print rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-800 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!selectedPair}
                    onClick={() => window.print()}
                  >
                    PDFとして保存
                  </button>
                  <button
                  className="non-print rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-800 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!selectedPair}
                  onClick={() => selectedPair && loadPreview(selectedPair)}
                >
                  再読み込み
                </button>
                </div>
              </div>

              <div className="relative flex justify-center overflow-auto bg-slate-50 p-4">
                {isLoadingPreview && (
                  <div className="absolute inset-0 flex items-center justify-center bg-white/70 backdrop-blur">
                    <div className="h-10 w-10 animate-spin rounded-full border-4 border-indigo-200 border-t-indigo-600" />
                  </div>
                )}

                {preview.html ? (
                  <div
                    className={`document-frame ${preview.landscape ? "landscape" : ""}`}
                    dangerouslySetInnerHTML={{ __html: preview.html }}
                  />
                ) : (
                  <div className="flex h-[70vh] w-full items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white text-slate-400">
                    プレビューを表示するペアを選択してください
                  </div>
                )}
              </div>
            </section>
          </section>
        )}
      </main>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          handleFilesSelected(e.target.files);
          if (e.target) e.target.value = "";
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          handleFilesSelected(e.target.files);
          if (e.target) e.target.value = "";
        }}
      />
    </div>
  );
};

export default App;
