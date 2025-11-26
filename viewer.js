const decompressZip = async (arrayBuffer) => {
    async function decompressData(compressedData) {
        const reader = new Blob([compressedData])
            .stream()
            .pipeThrough(new DecompressionStream("deflate-raw"))
            .getReader();
        const chunks = [];
        let result = await reader.read();
        while (!result.done) {
            chunks.push(result.value);
            result = await reader.read();
        }
        return new Blob(chunks);
    }

    const dataView = new DataView(arrayBuffer);
    let offset = 0;
    const files = [];

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

        if (pathName[pathName.length - 1] !== "/") {
            const decompressedData = await decompressData(
                arrayBuffer.slice(dataOffset, dataOffset + compressedSize)
            );
            const fileName = pathName.replace(/.*\//, "");
            files.push(new File([decompressedData], fileName));
        }
    }
    return files;
};

const convertXsl = async (sourceFiles) => {
    const unCompressPromises = sourceFiles.map(async (file) => {
        if (file.type.match(/^application\/(x-zip-compressed|zip)$/)) {
            return file.arrayBuffer().then(decompressZip);
        }
        return file;
    });
    const unCompressFiles = Promise.all(unCompressPromises).then(
        (files) => {
            return files.flat();
        }
    );
    const documentFiles = unCompressFiles.then(async (files) => {
        return Promise.all(
            files
                .filter((file) => file.name.match(/\.xml$|\.xsl$/))
                .map(async (file) => {
                    const parser = new DOMParser();
                    const xml = parser.parseFromString(
                        await file.text(),
                        "application/xml"
                    );
                    return [file.name, xml];
                })
        );
    });
    return documentFiles.then((files) => {
        const fileMap = Object.fromEntries(files);
        const xmlDocs = files.filter(([name]) => name.endsWith(".xml"));
        const documents = xmlDocs.map(([name, xmlDoc]) => {
            const xsltProcessor = new XSLTProcessor();
            const styleNodes = Array.from(xmlDoc.childNodes).filter(
                (node) =>
                    node.nodeType === Node.PROCESSING_INSTRUCTION_NODE &&
                    node.target === "xml-stylesheet"
            );
            styleNodes.forEach((styleNode) => {
                const href = styleNode.data.match(/href="([^"]+)"/)[1];
                const xslDoc = fileMap[href];
                if (xslDoc) xsltProcessor.importStylesheet(xslDoc);
            });
            const resultDoc = xsltProcessor.transformToDocument(xmlDoc);
            const serializer = new XMLSerializer();
            const resultString = serializer.serializeToString(resultDoc);
            return [name, resultString];
        });
        return documents;
    });
};

const applyTextFormatting = (contents) => {
    const oshiraseElements = contents.querySelectorAll("pre.oshirase");
    oshiraseElements.forEach(pre => {
        const originalText = pre.textContent;
        const cleanText = originalText.replace(/[\r\n\t]/g, '').replace(/ /g, '');

        let newText = '';
        let charCount = 0;

        for (let i = 0; i < cleanText.length; i++) {
            const char = cleanText[i];
            newText += char;

            const charCode = char.charCodeAt(0);
            const isFullWidth = charCode > 0x7F;

            charCount += isFullWidth ? 1 : 0.5;

            if (charCount >= 26 && i < cleanText.length - 1) {
                newText += '\n';
                charCount = 0;
            }
        }

        pre.textContent = newText;
    });

    const kyoujiElements = contents.querySelectorAll("pre.kyouji");
    kyoujiElements.forEach(pre => {
        const originalText = pre.textContent;
        const cleanText = originalText.replace(/[\r\n\t]/g, '').replace(/ /g, '');

        let newText = '';
        let charCount = 0;

        for (let i = 0; i < cleanText.length; i++) {
            const char = cleanText[i];
            newText += char;

            const charCode = char.charCodeAt(0);
            const isFullWidth = charCode > 0x7F;

            charCount += isFullWidth ? 1 : 0.5;

            if (charCount >= 48 && i < cleanText.length - 1) {
                newText += '\n';
                charCount = 0;
            }
        }

        pre.textContent = newText;
    });

    const tables = contents.querySelectorAll("table");
    tables.forEach(table => {
        const cells = table.querySelectorAll('td, th');
        cells.forEach(cell => {
            const text = cell.textContent.trim();
            if (text === '被保険者整理番号') {
                cell.style.textAlign = 'center';
            }
        });
    });
};

const fileStorage = new Map();
let fileIdCounter = 1;
const xslCache = new Map();
const xmlPool = new Map();
const processedFileKeys = new Set();

const addFilesToStorage = async (files) => {
    const processedFiles = [];

    const extractFolderName = (file) => {
        if (file.webkitRelativePath) {
            const parts = file.webkitRelativePath.split('/');
            return parts.length > 1 ? parts[0] : null;
        }
        return null;
    };

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const folderName = extractFolderName(file);

        const fileKey = `${file.webkitRelativePath || file.name}_${file.size}_${file.lastModified}`;
        if (processedFileKeys.has(fileKey)) {
            continue;
        }
        processedFileKeys.add(fileKey);

        if (file.type.match(/^application\/(x-zip-compressed|zip)$/) || file.name.endsWith('.zip')) {
            const unzipped = await file.arrayBuffer().then(decompressZip);
            unzipped.forEach(f => {
                processedFiles.push({
                    file: f,
                    sourceIndex: i,
                    sourceType: 'zip',
                    sourceName: file.name,
                    folderName: folderName
                });
            });
        } else {
            processedFiles.push({
                file: file,
                sourceIndex: i,
                sourceType: folderName ? 'folder' : 'direct',
                sourceName: file.name,
                folderName: folderName
            });
        }
    }

    const xmlFiles = [];
    const xslFiles = [];

    processedFiles.forEach(item => {
        const name = item.file.name;
        if (name.endsWith('.xml')) {
            xmlFiles.push(item);
        } else if (name.endsWith('.xsl')) {
            xslFiles.push(item);
        }
    });

    const newXslBasenames = [];
    for (const { file } of xslFiles) {
        const basename = file.name.replace(/\.xsl$/, '');
        const text = await file.text();
        const parser = new DOMParser();
        const xslDoc = parser.parseFromString(text, 'application/xml');
        const titleElement = xslDoc.querySelector('title');
        const title = titleElement ? titleElement.textContent.trim() : '';
        xslCache.set(basename, { file: file, title: title });
        newXslBasenames.push(basename);
    }

    for (const { file: xmlFile, sourceIndex, sourceType, sourceName, folderName } of xmlFiles) {
        const basename = xmlFile.name.replace(/\.xml$/, '');
        const xslData = xslCache.get(basename);

        const text = await xmlFile.text();
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(text, 'application/xml');
        const jigyoushoElements = xmlDoc.querySelectorAll('[*|事業所名], 事業所名');
        let jigyoushoName = '';
        if (jigyoushoElements.length > 0) {
            jigyoushoName = jigyoushoElements[0].textContent.trim();
        } else {
            const allElements = xmlDoc.getElementsByTagName('*');
            for (let elem of allElements) {
                if (elem.localName && elem.localName.includes('事業所名')) {
                    jigyoushoName = elem.textContent.trim();
                    break;
                }
            }
        }

        if (xslData) {
            const uniqueKey = `${basename}_${fileIdCounter++}_${Date.now()}`;
            fileStorage.set(uniqueKey, {
                basename: basename,
                xml: xmlFile,
                xsl: xslData.file,
                title: xslData.title,
                jigyoushoName: jigyoushoName,
                sourceInfo: {
                    sourceIndex: sourceIndex,
                    sourceType: sourceType,
                    sourceName: sourceName,
                    folderName: folderName
                }
            });
        } else {
            if (!xmlPool.has(basename)) {
                xmlPool.set(basename, []);
            }
            xmlPool.get(basename).push({
                file: xmlFile,
                jigyoushoName: jigyoushoName,
                sourceIndex: sourceIndex,
                sourceType: sourceType,
                sourceName: sourceName,
                folderName: folderName
            });

        }
    }

    newXslBasenames.forEach(basename => {
        const pooledXmls = xmlPool.get(basename);
        if (pooledXmls && pooledXmls.length > 0) {
            const xslData = xslCache.get(basename);
            pooledXmls.forEach(({ file: xmlFile, jigyoushoName, sourceIndex, sourceType, sourceName, folderName }) => {
                const uniqueKey = `${basename}_${fileIdCounter++}_${Date.now()}`;
                fileStorage.set(uniqueKey, {
                    basename: basename,
                    xml: xmlFile,
                    xsl: xslData.file,
                    title: xslData.title,
                    jigyoushoName: jigyoushoName,
                    sourceInfo: {
                        sourceIndex: sourceIndex,
                        sourceType: sourceType,
                        sourceName: sourceName,
                        folderName: folderName
                    }
                });
            });
            xmlPool.delete(basename);
        }
    });

    renderUI();
};

const showPair = (uniqueKey, pairData) => {
    const body = document.body;
    body.innerHTML = "";

    const allKeys = Array.from(fileStorage.keys());
    const currentIndex = allKeys.indexOf(uniqueKey);
    const prevKey = currentIndex > 0 ? allKeys[currentIndex - 1] : null;
    const nextKey = currentIndex < allKeys.length - 1 ? allKeys[currentIndex + 1] : null;

    convertXsl([pairData.xml, pairData.xsl]).then((docs) => {
        docs.forEach(([name, doc]) => {
            const contents = document.createElement("div");
            contents.innerHTML = doc;

            applyTextFormatting(contents);

            const container = document.createElement("div");
            const isLandscape = pairData.basename.startsWith('2');
            container.setAttribute("class", isLandscape ? "container landscape" : "container");

            const header = document.createElement("div");
            header.setAttribute("class", "page-header");

            const leftSection = document.createElement("div");
            leftSection.setAttribute("class", "header-left");

            const homeBtn = document.createElement("button");
            homeBtn.setAttribute("class", "home-btn");
            homeBtn.innerText = "ファイル一覧";
            homeBtn.onclick = () => {
                renderUI();
            };

            const clearBtn = document.createElement("button");
            clearBtn.setAttribute("class", "home-btn");
            clearBtn.style.cssText = "background: #f44336;";
            clearBtn.innerText = "クリア";
            clearBtn.onclick = () => {
                if (confirm('すべてのファイルをクリアしますか？\n（アップロードしたファイルがすべて削除されます）')) {
                    fileStorage.clear();
                    xslCache.clear();
                    xmlPool.clear();
                    renderUI();
                }
            };
            clearBtn.onmouseover = () => {
                clearBtn.style.background = "#d32f2f";
            };
            clearBtn.onmouseout = () => {
                clearBtn.style.background = "#f44336";
            };

            const countLabel = document.createElement("span");
            countLabel.style.cssText = "font-size: 14px; color: #666; margin-left: 8px;";
            countLabel.innerText = `${currentIndex + 1} / ${allKeys.length}`;

            leftSection.append(homeBtn, clearBtn, countLabel);

            const rightSection = document.createElement("div");
            rightSection.setAttribute("class", "header-left");
            rightSection.style.cssText = "gap: 8px;";

            const prevBtn = document.createElement("button");
            prevBtn.setAttribute("class", "home-btn");
            prevBtn.innerText = "前のファイル";
            prevBtn.style.cssText = prevKey ? "" : "opacity: 0.5; cursor: not-allowed;";
            prevBtn.disabled = !prevKey;
            if (prevKey) {
                prevBtn.onclick = () => {
                    const prevPairData = fileStorage.get(prevKey);
                    showPair(prevKey, prevPairData);
                };
            }

            const nextBtn = document.createElement("button");
            nextBtn.setAttribute("class", "home-btn");
            nextBtn.innerText = "次のファイル";
            nextBtn.style.cssText = nextKey ? "" : "opacity: 0.5; cursor: not-allowed;";
            nextBtn.disabled = !nextKey;
            if (nextKey) {
                nextBtn.onclick = () => {
                    const nextPairData = fileStorage.get(nextKey);
                    showPair(nextKey, nextPairData);
                };
            }

            const printBtn = document.createElement("button");
            printBtn.setAttribute("class", "print-btn");
            printBtn.innerText = "PDFとして保存";
            printBtn.onclick = () => window.print();

            rightSection.append(prevBtn, nextBtn, printBtn);

            header.append(leftSection, rightSection);

            const infoSection = document.createElement("div");
            infoSection.setAttribute("class", "info-section");
            infoSection.style.cssText = "padding: 12px 16px; background: #f9f9f9; border-bottom: 1px solid #ddd;";

            if (pairData.title) {
                const titleDiv = document.createElement("div");
                titleDiv.style.cssText = "font-size: 18px; font-weight: bold; color: #333; margin-bottom: 6px;";
                titleDiv.innerText = pairData.title;
                infoSection.appendChild(titleDiv);
            }

            if (pairData.jigyoushoName) {
                const companyDiv = document.createElement("div");
                companyDiv.style.cssText = "font-size: 16px; color: #555;";
                companyDiv.innerText = pairData.jigyoushoName;
                infoSection.appendChild(companyDiv);
            }

            container.append(header, infoSection, contents);
            body.append(container);

            const handleKeyPress = (e) => {
                if (e.key === 'ArrowLeft' && prevKey) {
                    const prevPairData = fileStorage.get(prevKey);
                    showPair(prevKey, prevPairData);
                } else if (e.key === 'ArrowRight' && nextKey) {
                    const nextPairData = fileStorage.get(nextKey);
                    showPair(nextKey, nextPairData);
                } else if (e.key === 'Escape') {
                    renderUI();
                }
            };

            document.removeEventListener('keydown', handleKeyPress);
            document.addEventListener('keydown', handleKeyPress);
        });
    });
};

const deletePair = (uniqueKey, basename) => {
    if (confirm(`「${basename}」のペアを削除しますか？`)) {
        fileStorage.delete(uniqueKey);
        renderUI();
    }
};

const handleDrop = async (e) => {
    e.preventDefault();

    const items = e.dataTransfer.items;
    const allFiles = [];

    const processEntry = async (entry, path = '') => {
        if (entry.isFile) {
            return new Promise((resolve) => {
                entry.file((file) => {
                    if (path) {
                        Object.defineProperty(file, 'webkitRelativePath', {
                            value: path + file.name,
                            writable: false,
                            configurable: true
                        });
                    }
                    resolve(file);
                }, (error) => {
                    console.error('File read error:', error);
                    resolve(null);
                });
            });
        } else if (entry.isDirectory) {
            const dirReader = entry.createReader();
            const allEntries = [];

            const readAllEntries = async () => {
                return new Promise((resolve) => {
                    const readBatch = () => {
                        dirReader.readEntries(async (entries) => {
                            if (entries.length === 0) {
                                resolve(allEntries);
                            } else {
                                allEntries.push(...entries);
                                readBatch();
                            }
                        }, (error) => {
                            console.error('Directory read error:', error);
                            resolve(allEntries);
                        });
                    };
                    readBatch();
                });
            };

            const entries = await readAllEntries();
            const promises = [];
            for (const subEntry of entries) {
                promises.push(processEntry(subEntry, path + entry.name + '/'));
            }
            const results = await Promise.all(promises);
            return results.flat().filter(f => f);
        }
        return null;
    };

    if (items && items.length > 0) {
        const promises = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind === 'file') {
                const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
                if (entry) {
                    promises.push(processEntry(entry));
                } else {
                    const file = item.getAsFile();
                    if (file) {
                        promises.push(Promise.resolve(file));
                    }
                }
            }
        }

        if (promises.length > 0) {
            const results = await Promise.all(promises);
            allFiles.push(...results.flat().filter(f => f));
        }
    }

    if (allFiles.length === 0 && e.dataTransfer.files.length > 0) {
        allFiles.push(...Array.from(e.dataTransfer.files));
    }

    if (allFiles.length > 0) {
        addFilesToStorage(allFiles);
    }
};

let currentSelectedKey = null;

const renderPreview = (uniqueKey, pairData) => {
    const rightPanel = document.querySelector('.right-panel');
    if (!rightPanel) return;

    rightPanel.innerHTML = "";
    currentSelectedKey = uniqueKey;

    document.querySelectorAll('.file-item').forEach(item => {
        item.classList.remove('active');
    });
    const activeItem = document.querySelector(`[data-key="${uniqueKey}"]`);
    if (activeItem) {
        activeItem.classList.add('active');
    }

    const allKeys = Array.from(fileStorage.keys());
    const currentIndex = allKeys.indexOf(uniqueKey);

    convertXsl([pairData.xml, pairData.xsl]).then((docs) => {
        docs.forEach(([name, doc]) => {
            const contents = document.createElement("div");
            contents.innerHTML = doc;

            applyTextFormatting(contents);

            const container = document.createElement("div");
            const isLandscape = pairData.basename.startsWith('2');
            container.setAttribute("class", isLandscape ? "container landscape" : "container");

            const header = document.createElement("div");
            header.setAttribute("class", "page-header");

            const leftSection = document.createElement("div");
            leftSection.setAttribute("class", "header-left");

            const countLabel = document.createElement("span");
            countLabel.style.cssText = "font-size: 14px; color: #666;";
            countLabel.innerText = `${currentIndex + 1} / ${allKeys.length}`;

            const printBtn = document.createElement("button");
            printBtn.setAttribute("class", "print-btn");
            printBtn.innerText = "PDFとして保存";
            printBtn.onclick = () => window.print();

            leftSection.append(countLabel, printBtn);
            header.append(leftSection);

            const infoSection = document.createElement("div");
            infoSection.setAttribute("class", "info-section");
            infoSection.style.cssText = "padding: 12px 16px; background: #f9f9f9; border-bottom: 1px solid #ddd;";

            if (pairData.title) {
                const titleDiv = document.createElement("div");
                titleDiv.style.cssText = "font-size: 18px; font-weight: bold; color: #333; margin-bottom: 6px;";
                titleDiv.innerText = pairData.title;
                infoSection.appendChild(titleDiv);
            }

            if (pairData.jigyoushoName) {
                const companyDiv = document.createElement("div");
                companyDiv.style.cssText = "font-size: 16px; color: #555;";
                companyDiv.innerText = pairData.jigyoushoName;
                infoSection.appendChild(companyDiv);
            }

            container.append(header, infoSection, contents);
            rightPanel.append(container);
        });
    });
};

const renderUI = () => {
    const body = document.body;
    body.innerHTML = "";

    body.ondragover = (e) => e.preventDefault();
    body.ondrop = handleDrop;

    const completePairs = [];

    for (const [uniqueKey, pairData] of fileStorage) {
        completePairs.push({
            uniqueKey,
            basename: pairData.basename,
            xml: pairData.xml,
            xsl: pairData.xsl,
            title: pairData.title,
            jigyoushoName: pairData.jigyoushoName
        });
    }

    const dropZone = document.createElement("div");
    dropZone.setAttribute("class", "drop-zone");

    // ヘッダーセクション
    const header = document.createElement("div");
    header.setAttribute("class", "drop-zone-header");

    const title = document.createElement("h1");
    title.setAttribute("class", "drop-zone-title");
    title.innerText = "電子公文書 PDF変換システム";
    header.appendChild(title);

    const subtitle = document.createElement("p");
    subtitle.setAttribute("class", "drop-zone-subtitle");
    subtitle.innerText = "XML/XSLファイルをブラウザでPDFに変換";
    header.appendChild(subtitle);

    dropZone.appendChild(header);

    // メインコンテンツ
    const content = document.createElement("div");
    content.setAttribute("class", "drop-zone-content");

    const fileLabel = document.createElement("label");
    fileLabel.setAttribute("class", "drop-label");
    fileLabel.innerHTML = "ファイル・フォルダ・ZIPをドロップ<br><small style=\'font-size: 14px; opacity: 0.8; font-weight: 400;\'>またはクリックして選択</small>";

    const fileInput = document.createElement("input");
    fileInput.setAttribute("type", "file");
    fileInput.setAttribute("class", "file-input");
    fileInput.setAttribute("multiple", "true");
    fileInput.setAttribute("webkitdirectory", "");
    fileInput.setAttribute("directory", "");
    fileInput.onchange = (e) => {
        addFilesToStorage(Array.from(e.target.files));
        e.target.value = '';
    };

    fileLabel.appendChild(fileInput);
    content.appendChild(fileLabel);

    dropZone.appendChild(content);

    if (completePairs.length > 0) {
        const splitView = document.createElement("div");
        splitView.setAttribute("class", "split-view");

        const leftPanel = document.createElement("div");
        leftPanel.setAttribute("class", "left-panel");

        const leftHeader = document.createElement("div");
        leftHeader.setAttribute("class", "left-panel-header");

        const headerTop = document.createElement("div");
        headerTop.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;";

        const headerTitle = document.createElement("h3");
        headerTitle.style.cssText = "margin: 0; color: #333;";
        headerTitle.innerText = `ファイル一覧 (${completePairs.length}件)`;

        const backBtn = document.createElement("button");
        backBtn.setAttribute("class", "home-btn");
        backBtn.style.cssText = "padding: 4px 8px; font-size: 11px;";
        backBtn.innerText = "トップに戻る";
        backBtn.onclick = () => {
            fileStorage.clear();
            xslCache.clear();
            xmlPool.clear();
            processedFileKeys.clear();
            renderUI();
        };

        headerTop.append(headerTitle, backBtn);

        const headerButtons = document.createElement("div");
        headerButtons.style.cssText = "display: flex; gap: 4px;";

        const addFileBtn = document.createElement("button");
        addFileBtn.setAttribute("class", "home-btn");
        addFileBtn.style.cssText = "padding: 4px 8px; font-size: 11px;";
        addFileBtn.innerText = "追加";
        addFileBtn.onclick = () => fileInput.click();

        const clearBtn = document.createElement("button");
        clearBtn.setAttribute("class", "home-btn");
        clearBtn.style.cssText = "background: #f44336; padding: 4px 8px; font-size: 11px;";
        clearBtn.innerText = "全削除";
        clearBtn.onclick = () => {
            if (confirm('すべてのファイルをクリアしますか？')) {
                fileStorage.clear();
                xslCache.clear();
                xmlPool.clear();
                processedFileKeys.clear();
                renderUI();
            }
        };
        clearBtn.onmouseover = () => { clearBtn.style.background = "#d32f2f"; };
        clearBtn.onmouseout = () => { clearBtn.style.background = "#f44336"; };

        headerButtons.append(addFileBtn, clearBtn);
        
        // 倍率調整コントロール
        let currentZoom = 100;
        
        const zoomRow = document.createElement("div");
        zoomRow.style.cssText = "display: flex; gap: 4px; align-items: center; margin-top: 6px; padding-top: 6px; border-top: 1px solid #ddd;";
        
        const zoomControl = document.createElement("div");
        zoomControl.setAttribute("class", "zoom-control");
        zoomControl.style.cssText = "display: flex; align-items: center; gap: 4px; padding: 3px 6px; background: #fafafa; border-radius: 3px; border: 1px solid #ddd; flex: 1;";

        const zoomLabel = document.createElement("label");
        zoomLabel.style.cssText = "font-size: 11px !important; color: #555 !important; margin: 0;";
        zoomLabel.innerText = "表示:";

        const zoomOutBtn = document.createElement("button");
        zoomOutBtn.setAttribute("class", "zoom-btn");
        zoomOutBtn.style.cssText = "padding: 2px 8px; font-size: 11px; background: #fff; color: #333; border: 1px solid #ccc; border-radius: 2px; cursor: pointer;";
        zoomOutBtn.innerText = "−";
        zoomOutBtn.onclick = () => {
            if (currentZoom > 30) {
                currentZoom -= 10;
                zoomValue.innerText = `${currentZoom}%`;
                const allContainers = document.querySelectorAll('.right-panel .container');
                allContainers.forEach(c => c.style.transform = `scale(${currentZoom / 100})`);
            }
        };

        const zoomValue = document.createElement("span");
        zoomValue.setAttribute("class", "zoom-value");
        zoomValue.style.cssText = "font-size: 11px !important; color: #333 !important; min-width: 35px; text-align: center; font-weight: 600;";
        zoomValue.innerText = "100%";

        const zoomInBtn = document.createElement("button");
        zoomInBtn.setAttribute("class", "zoom-btn");
        zoomInBtn.style.cssText = "padding: 2px 8px; font-size: 11px; background: #fff; color: #333; border: 1px solid #ccc; border-radius: 2px; cursor: pointer;";
        zoomInBtn.innerText = "＋";
        zoomInBtn.onclick = () => {
            if (currentZoom < 150) {
                currentZoom += 10;
                zoomValue.innerText = `${currentZoom}%`;
                const allContainers = document.querySelectorAll('.right-panel .container');
                allContainers.forEach(c => c.style.transform = `scale(${currentZoom / 100})`);
            }
        };

        const zoomResetBtn = document.createElement("button");
        zoomResetBtn.setAttribute("class", "zoom-btn");
        zoomResetBtn.style.cssText = "padding: 2px 8px; font-size: 11px; background: #fff; color: #333; border: 1px solid #ccc; border-radius: 2px; cursor: pointer;";
        zoomResetBtn.innerText = "100%";
        zoomResetBtn.onclick = () => {
            currentZoom = 100;
            zoomValue.innerText = "100%";
            const allContainers = document.querySelectorAll('.right-panel .container');
            allContainers.forEach(c => c.style.transform = "scale(1)");
        };

        zoomControl.append(zoomLabel, zoomOutBtn, zoomValue, zoomInBtn, zoomResetBtn);
        zoomRow.appendChild(zoomControl);
        
        leftHeader.append(headerTop, headerButtons, zoomRow);

        const leftContent = document.createElement("div");
        leftContent.setAttribute("class", "left-panel-content");

        const dropArea = document.createElement("div");
        dropArea.setAttribute("class", "drop-area-compact");
        dropArea.innerHTML = "ファイル・フォルダ・zipファイル<br><small style='color: #999; font-size: 10px;'>をドラッグ&ドロップしてください</small>";
        dropArea.onclick = () => fileInput.click();

        dropArea.ondragover = (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropArea.classList.add('drag-over');
        };

        dropArea.ondragleave = (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropArea.classList.remove('drag-over');
        };

        dropArea.ondrop = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropArea.classList.remove('drag-over');
            await handleDrop(e);
        };

        leftContent.appendChild(dropArea);

        const fileList = document.createElement("div");
        fileList.setAttribute("class", "file-list");

        const basenameCount = new Map();
        completePairs.forEach(({ basename }) => {
            basenameCount.set(basename, (basenameCount.get(basename) || 0) + 1);
        });

        const basenameIndex = new Map();
        completePairs.forEach(({ uniqueKey, basename, xml, xsl }) => {
            const pairData = fileStorage.get(uniqueKey);

            const fileItem = document.createElement("div");
            fileItem.setAttribute("class", "file-item");
            fileItem.setAttribute("data-key", uniqueKey);

            const actions = document.createElement("div");
            actions.setAttribute("class", "pair-actions");

            const deleteBtn = document.createElement("button");
            deleteBtn.setAttribute("class", "btn-delete");
            deleteBtn.style.cssText = "padding: 3px 8px; font-size: 10px;";
            deleteBtn.innerText = "削除";
            deleteBtn.onclick = (e) => {
                e.stopPropagation();
                if (confirm(`「${pairData.title || basename}」を削除しますか？`)) {
                    fileStorage.delete(uniqueKey);
                    renderUI();
                }
            };
            actions.appendChild(deleteBtn);

            const contentDiv = document.createElement("div");
            contentDiv.setAttribute("class", "file-item-content");
            contentDiv.onclick = () => renderPreview(uniqueKey, pairData);

            const nameEl = document.createElement("strong");

            let finalDisplayName = basename;
            if (basenameCount.get(basename) > 1) {
                const currentIndex = (basenameIndex.get(basename) || 0) + 1;
                basenameIndex.set(basename, currentIndex);
                finalDisplayName = `${basename} (#${currentIndex})`;
            }

            let displayTitle = '';
            if (pairData.title) {
                displayTitle = pairData.title;
                if (basenameCount.get(basename) > 1) {
                    displayTitle += ` (#${basenameIndex.get(basename)})`;
                }
            } else {
                displayTitle = finalDisplayName;
            }

            nameEl.innerText = displayTitle;
            contentDiv.appendChild(nameEl);

            if (pairData.jigyoushoName) {
                const companyEl = document.createElement('div');
                companyEl.setAttribute('class', 'company-name');
                companyEl.innerText = pairData.jigyoushoName;
                contentDiv.appendChild(companyEl);
            }

            const statusEl = document.createElement("div");
            statusEl.setAttribute("class", "status");

            let sourceInfo = '';
            if (pairData.sourceInfo) {
                if (pairData.sourceInfo.sourceType === 'zip') {
                    sourceInfo = `<br><small style="color: #999;">${pairData.sourceInfo.sourceName} から抽出</small>`;
                } else if (pairData.sourceInfo.sourceType === 'folder' && pairData.sourceInfo.folderName) {
                    sourceInfo = `<br><small style="color: #999;">${pairData.sourceInfo.folderName} フォルダから</small>`;
                }
            }

            statusEl.innerHTML = `${xml.name} (${(xml.size / 1024).toFixed(1)} KB) / ${xsl.name} (${(xsl.size / 1024).toFixed(1)} KB)${sourceInfo}`;
            contentDiv.appendChild(statusEl);

            fileItem.append(actions, contentDiv);
            fileList.appendChild(fileItem);
        });

        leftContent.appendChild(fileList);
        leftPanel.append(leftHeader, leftContent);

        const rightPanel = document.createElement("div");
        rightPanel.setAttribute("class", "right-panel");

        const placeholder = document.createElement("div");
        placeholder.setAttribute("class", "preview-placeholder");
        placeholder.innerText = "左側のファイルを選択してプレビューを表示";
        rightPanel.appendChild(placeholder);

        const resizer = document.createElement("div");
        resizer.setAttribute("class", "resizer");

        let isResizing = false;
        let startX = 0;
        let startWidth = 0;

        resizer.addEventListener('mousedown', (e) => {
            isResizing = true;
            startX = e.clientX;
            startWidth = leftPanel.offsetWidth;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;

            const delta = e.clientX - startX;
            const newWidth = startWidth + delta;
            const minWidth = 250;
            const maxWidth = window.innerWidth * 0.7;

            if (newWidth >= minWidth && newWidth <= maxWidth) {
                leftPanel.style.width = newWidth + 'px';
                leftPanel.style.minWidth = newWidth + 'px';
                leftPanel.style.maxWidth = newWidth + 'px';
            }
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        });

        splitView.append(leftPanel, resizer, rightPanel);
        body.appendChild(splitView);

        if (completePairs.length > 0) {
            renderPreview(completePairs[0].uniqueKey, fileStorage.get(completePairs[0].uniqueKey));
        }

        return;
    }

    const instructions = document.createElement("div");
    instructions.setAttribute("class", "instructions");

    if (completePairs.length === 0) {
        instructions.innerHTML = `
                    <h3>使い方</h3>
                    <ol>
                        <li><strong>アップロード方法</strong>
                            <ul>
                                <li><strong>ドラッグ&ドロップ</strong>: ファイル・フォルダ・ZIPをドロップしてアップロードします</li>
                            </ul>
                        </li>
                        <li>ファイル名（拡張子除く）が一致するペアを自動検出</li>
                        <li>完成ペアのみが一覧に表示されます</li>
                        <li>「プレビュー & PDF保存」ボタンでA4用紙プレビューを表示</li>
                        <li>「PDFとして保存」ボタンをクリック</li>
                        <li>印刷ダイアログで「送信先」→「PDFに保存」を選択</li>
                    </ol>
                `;
    } else {
        instructions.innerHTML = `
                    <h3>操作方法</h3>
                    <ul>
                        <li><strong>プレビュー</strong>: 左側の一覧から公文書を選択するとA4用紙プレビューが表示されます</li>
                        <li><strong>PDF保存</strong>: プレビュー画面で「PDFとして保存」→ 印刷ダイアログで「PDFに保存」</li>
                        <li><strong>同名ファイル対応</strong>: ファイル名が同じ場合は (#1), (#2) で区別</li>
                        <li><strong>一覧表へのドラッグアンドドロップで追加対応</strong>: 一覧表にドラッグ&ドロップでファイル追加可能</li>
                    </ul>
                `;
    }

    dropZone.appendChild(instructions);
    body.appendChild(dropZone);
};

window.onload = () => {
    renderUI();
};
