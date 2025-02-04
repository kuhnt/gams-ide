const vscode = require("vscode");
const clearScrdir = require("./src/utils/clearScrdir");
const updateDiagnostics = require("./src/diagnostics");
const runGams = require("./src/runGams");
const getSymbolUnderCursor = require("./src/getSymbolUnderCursor");
const getGamsIdeViewContainerContent = require("./src/utils/getGamsIdeViewContainerContent");
const getGamsIdeSymbolViewContainerContent = require("./src/utils/getGamsIdeSymbolViewContainerContent");
const debouncedListenToLstFiles = require("./src/parseLstFiles");
const State = require("./src/State.js");

let terminal;
let gamsView;
let gamsSymbolView;

async function activate(context) {
  // first, we try to delete all contents of the scratch directory (scrdir) to avoid
  // conflicts with previous runs
  await clearScrdir();
  // check if a terminal with the name "GAMS" already exists
  terminal = vscode.window.terminals.find((terminal) => terminal.name === "GAMS");
  // if not, create a terminal for compiling and executing GAMS files
  if (!terminal) terminal = vscode.window.createTerminal("GAMS");

  const state = new State();
  // start listening to save events to generate diagnostics
  const collection = vscode.languages.createDiagnosticCollection("gams");
  if (vscode.window.activeTextEditor) {
    const document = vscode.window.activeTextEditor.document;
    // check if the active editor is a GAMS file
    if (document.languageId === "gams") {
      await updateDiagnostics({ document, collection, gamsSymbolView, state, terminal });
    } else if (document.fileName.toLowerCase().endsWith('.lst')) {
      await debouncedListenToLstFiles({
        document,
        contentChanges: ["yay"], // fake content changes to trigger the update
        gamsView,
        state
      });
    }
  }

  // update both diagnostics and listing file parsing on editor change
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      let isListing = false;
      if (editor && editor.document.languageId === "gams") {
        await updateDiagnostics({
          document: editor.document,
          collection,
          gamsSymbolView,
          state,
          terminal
        });
      } else if (editor && editor.document.fileName.toLowerCase().endsWith('.lst')) {
        isListing = true;
        await debouncedListenToLstFiles({
          document: editor.document,
          contentChanges: ["yay"], // fake content changes to trigger the update
          gamsView,
          state
        });
      }
      if (gamsView) {
        // change the webview to either show the listing contents or the GAMS reference tree
        gamsView.webview.postMessage({
          command: "showGAMSorListing",
          data: {
            isListing
          }
        });
      }
    })
  );

  // start listening to save events to generate diagnostics
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (document && document.languageId === "gams") {
        await updateDiagnostics({ document, collection, gamsSymbolView, state, terminal });
      }
    })
  );

  // register a command to get the symbol under the cursor
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(async (event) => {
      if (event && event.textEditor.document.languageId === "gams" && event.kind) {
        getSymbolUnderCursor({ event, gamsSymbolView, state, gamsView });
      }
    })
  );

  // register a command to execute a GAMS file
  context.subscriptions.push(
    vscode.commands.registerCommand("gams.run", () => runGams(terminal))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gams.runThisFile", () => runGams(terminal, false, true))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gams.compile", () => runGams(terminal, true))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gams.compileThisFile", () => runGams(terminal, true, true))
  );

  // add a listener to all .lst files, that scrolls to the bottom of the file 
  // if they are changed externally
  context.subscriptions.push(
    // Register a listener for listing file changes
    vscode.workspace.onDidChangeTextDocument((event) => {
      return debouncedListenToLstFiles({
        document: event.document,
        contentChanges: event.contentChanges,
        gamsView,
        state
      });
    })
  );

  // add the gams reference tree sidebar
  vscode.window.registerWebviewViewProvider('gamsIdeView', {
    // Implement the resolveWebviewView method
    resolveWebviewView(webviewView, undefined, token) {
      gamsView = webviewView;
      // Set the webview options
      webviewView.webview.options = {
        enableScripts: true
      };
      const vueUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'view', 'vue.esm-browser.js'));
      const webviewToolkitUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'view', 'webview-ui-toolkit.esm.js'));
      const codiconsUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'view', 'codicon.css'));
      // Set the webview content
      webviewView.webview.html = getGamsIdeViewContainerContent({
        vueUri,
        webviewToolkitUri,
        codiconsUri
      });

      // Handle messages from the webview
      webviewView.webview.onDidReceiveMessage(
        async message => {
          // get current cursor position
          const editor = vscode.window.activeTextEditor;
          const position = editor.selection?.active ;
          const file = editor.document?.fileName;
          const line = position?.line;
          const column = position?.character;

          switch (message.command) {
            case 'jumpToPosition':
              let uri = vscode.Uri.file(message.data.file);
              // Create a TextDocumentShowOptions object with the line and column
              let options = {
                selection: new vscode.Range(
                  message.data.line - 1,
                  message.data.column - 1,
                  message.data.line - 1,
                  message.data.column - 1
                ),
                preview: true
              };
              // Open the document with the options
              vscode.workspace.openTextDocument(uri).then(doc => {
                vscode.window.showTextDocument(doc, options);
              });
              break;
            case 'updateSymbol':
              const referenceTree = state.get("referenceTree");
              let matchingRef;
              if (message.data.fuzzy) {
                matchingRef = referenceTree?.find((item) => item.name?.toLowerCase().includes(message.data.symbol?.toLowerCase()));
              } else {
                matchingRef = referenceTree?.find((item) => item.name?.toLowerCase() === message.data.symbol?.toLowerCase());
              }

              if (matchingRef) {
                gamsView.webview.postMessage({
                  command: "updateReference",
                  data: {
                    ...matchingRef,
                    historyCursorFile: file,
                    historyCursorLine: line + 1,
                    historyCursorColumn: column + 1
                  }
                });
              }
              break;
            case 'runGams':
              await runGams(terminal);
              break;
            case 'stopGams':
              terminal.sendText(String.fromCharCode(3));
              break;
            case 'getState':
              const isListing = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.fileName.toLowerCase().endsWith('.lst');
              if (isListing) {
                const lstTree = state.get("lstTree");
                if (lstTree) {
                  webviewView.webview.postMessage({
                    command: "updateListing",
                    data: {
                      lstTree,
                      isListing
                    }
                  });
                }
              } else {
                const curSymbol = state.get("curSymbol");
                if (curSymbol) {
                  webviewView.webview.postMessage({
                    command: "updateListing",
                    data: curSymbol
                  });
                }
              }
              break;
          }
        },
        undefined,
        context.subscriptions
      );
        
    }
  })
  context.subscriptions.push(gamsView);
  // add a command to open the gams reference tree sidebar
  context.subscriptions.push(
    vscode.commands.registerCommand("gams.openSidebar", () => {
      gamsView.show();
    })
  );

  // gams symbol view
  function createGamsSymbolView() {
    return {
      // Implement the resolveWebviewView method
      resolveWebviewView(webviewView, undefined, token) {
        gamsSymbolView = webviewView;
        // Set the webview options
        webviewView.webview.options = {
          enableScripts: true
        };
        
        const webviewToolkitUri = webviewView.webview.asWebviewUri(
          vscode.Uri.joinPath(context.extensionUri, 'view', 'webview-ui-toolkit.esm.js'));
        const codiconsUri = webviewView.webview.asWebviewUri(
          vscode.Uri.joinPath(
            context.extensionUri, 'view', 'codicon.css'
          )
        );
        // Set the webview content
        webviewView.webview.html = getGamsIdeSymbolViewContainerContent({
          webviewToolkitUri,
          codiconsUri,
          isSymbolParsingEnabled: vscode.workspace.getConfiguration("gamsIde").get("parseSymbolValues")
        });

        webviewView.webview.onDidReceiveMessage(async message => {
          switch (message.command) {
            case 'enableSymbolParsing':
              vscode.workspace.getConfiguration("gamsIde").update("parseSymbolValues", true);
              break;
          }
        });
      }
    }
  }
  // add the gams symbol view if enabled
  let showSymbolViewCommandDisposable, gamsSymbolViewDisposable;
  // create the gams symbol view
  gamsSymbolViewDisposable = vscode.window.registerWebviewViewProvider('gamsIdeSymbolView', createGamsSymbolView())
  context.subscriptions.push(gamsSymbolViewDisposable);

  // add a command to open the gams symbol view sidebar
  showSymbolViewCommandDisposable = vscode.commands.registerCommand("gams.openSymbolPanel", () => {
    // make sure the bottom panel is open
    vscode.commands.executeCommand("workbench.action.togglePanel");
    // check if parsing symbols is enabled
    if (!vscode.workspace.getConfiguration("gamsIde").get("parseSymbolValues")) {
      vscode.window.showErrorMessage("Symbol parsing is disabled.", "Enable symbol parsing").then((value) => {
        if (value === "Enable symbol parsing") {
          vscode.workspace.getConfiguration("gamsIde").update("parseSymbolValues", true);
        }
      });
    } else {
      gamsSymbolView?.show();
    }
  })

  context.subscriptions.push(showSymbolViewCommandDisposable);

  // listen to changes to the parseSymbolValues setting
  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("gamsIde.parseSymbolValues")) {      
      // send a message to the symbol view to update the content
      const isSymbolParsingEnabled = vscode.workspace.getConfiguration("gamsIde").get("parseSymbolValues");
      gamsSymbolView?.webview.postMessage({
        command: "isSymbolParsingEnabled",
        data: {
          isSymbolParsingEnabled
        }
      });

      if (isSymbolParsingEnabled) {
        // re-run diagnostics so that the symbol view is updated
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === "gams") {
          updateDiagnostics({ document: editor.document, collection, gamsSymbolView, state, terminal });
        }
      }
    }
  });
}

// this method is called when your extension is deactivated
function deactivate() { }

module.exports = {
  activate,
  deactivate,
};
