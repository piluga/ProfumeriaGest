let FIREBASE_URL = localStorage.getItem("gestionale_firebase_url") || "";

// ==========================================
// 🛑 BLOCCO AUTOCOMPLETAMENTO BROWSER
// ==========================================
document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll('input, textarea').forEach(campo => {
        campo.setAttribute('autocomplete', 'off');
        // Hack per forzare Chrome a ignorare davvero i campi
        campo.setAttribute('data-lpignore', 'true');
    });
});

// 🗄️ DATABASE INDEXEDDB
const DB_NAME = 'CassaPWA_DB';
const DB_VERSION = 8;
let db;

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = function (event) {
            db = event.target.result;
            const tx = event.currentTarget.transaction;

            if (!db.objectStoreNames.contains('magazzino')) { db.createObjectStore('magazzino', { keyPath: 'codice' }); }
            if (!db.objectStoreNames.contains('vouchers')) { db.createObjectStore('vouchers', { keyPath: 'codice' }); }
            if (!db.objectStoreNames.contains('sys_logs')) {db.createObjectStore('sys_logs', { keyPath: 'id', autoIncrement: true }); }

            // --- NUOVO STORE PER GLI ORDINI FORNITORI ---
            if (!db.objectStoreNames.contains('ordini')) {
                db.createObjectStore('ordini', { keyPath: 'id_ordine' });
            }

            // --- NUOVO STORE PER LE CHIUSURE DI CASSA (Z) ---
            if (!db.objectStoreNames.contains('chiusure')) {
                db.createObjectStore('chiusure', { keyPath: 'data_chiusura' });
            }

            // --- NUOVO STORE PER LE GIFT CARD ---
            if (!db.objectStoreNames.contains('giftcards')) {
                db.createObjectStore('giftcards', { keyPath: 'codice' });
            }

            let storeClienti;
            if (!db.objectStoreNames.contains('clienti')) { storeClienti = db.createObjectStore('clienti', { keyPath: 'scheda' }); } else { storeClienti = tx.objectStore('clienti'); }
            if (!storeClienti.indexNames.contains('telefono')) { storeClienti.createIndex('telefono', 'telefono', { unique: false }); }

            let storeVendite;
            if (!db.objectStoreNames.contains('vendite')) { storeVendite = db.createObjectStore('vendite', { keyPath: 'id', autoIncrement: true }); } else { storeVendite = tx.objectStore('vendite'); }
            if (!storeVendite.indexNames.contains('giorno')) { storeVendite.createIndex('giorno', 'GIORNO', { unique: false }); }

            let storeMov;
            if (!db.objectStoreNames.contains('movimenti_cassa')) { storeMov = db.createObjectStore('movimenti_cassa', { keyPath: 'id', autoIncrement: true }); } else { storeMov = tx.objectStore('movimenti_cassa'); }
            if (!storeMov.indexNames.contains('data')) { storeMov.createIndex('data', 'data', { unique: false }); }
        };

        request.onsuccess = function (event) {
            db = event.target.result;
            resolve();

            // Avvia la sincronizzazione silenziosa in background
            setTimeout(() => {
                scaricaClientiDalCloud();
                scaricaMagazzinoDalCloud();
                if (typeof scaricaVenditeDalCloud === "function") scaricaVenditeDalCloud();     // 🚀 Recupero Storico Scontrini
                if (typeof scaricaMovimentiDalCloud === "function") scaricaMovimentiDalCloud(); // 🚀 Recupero Storico Spese
            }, 4000);
        };

        request.onerror = function (event) { reject("Errore DB: " + event.target.errorCode); };
    });
}

// Helpers DB
function getAll(storeName) { return new Promise((resolve) => { let tx = db.transaction(storeName, 'readonly'); let request = tx.objectStore(storeName).getAll(); request.onsuccess = () => resolve(request.result); }); }
function getByDate(storeName, indexName, dataCercata) { return new Promise((resolve) => { let tx = db.transaction(storeName, 'readonly'); let index = tx.objectStore(storeName).index(indexName); let request = index.getAll(IDBKeyRange.only(dataCercata)); request.onsuccess = () => resolve(request.result); }); }
function getBySchedaOTelefono(valore) { return new Promise((resolve) => { let tx = db.transaction('clienti', 'readonly'); let store = tx.objectStore('clienti'); let reqScheda = store.get(valore); reqScheda.onsuccess = () => { if (reqScheda.result) { resolve(reqScheda.result); } else { let index = store.index('telefono'); let reqTel = index.get(valore); reqTel.onsuccess = () => resolve(reqTel.result); } }; }); }
function updateCliente(cliente) {
    return new Promise((resolve) => {
        let tx = db.transaction('clienti', 'readwrite');
        tx.objectStore('clienti').put(cliente);
        tx.oncomplete = () => {
            // ☁️ CLOUD-SYNC: Appena il dato viene salvato nel PC locale, lo spara al Cloud!
            if (typeof salvaClienteCloud === "function") {
                salvaClienteCloud(cliente);
            }
            resolve();
        };
    });
}
function deleteRecord(storeName, key) { return new Promise((resolve) => { let tx = db.transaction(storeName, 'readwrite'); tx.objectStore(storeName).delete(key); tx.oncomplete = () => resolve(); }); }

function salvaMovimentoCassaDB(movimento) {
    return new Promise((resolve) => {
        if (!movimento.id) movimento.id = Date.now(); // 🚀 ID indistruttibile anti-reset
        let tx = db.transaction('movimenti_cassa', 'readwrite');
        tx.objectStore('movimenti_cassa').put(movimento);
        tx.oncomplete = () => {
            if (typeof salvaMovimentoCloud === "function") salvaMovimentoCloud(movimento); // 🚀 Push al Cloud
            resolve(movimento.id);
        };
    });
}
function getRecordById(storeName, id) { return new Promise((resolve) => { let tx = db.transaction(storeName, 'readonly'); let request = tx.objectStore(storeName).get(id); request.onsuccess = () => resolve(request.result); }); }

// Helper Data
function getOggiString() {
    let d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 🧠 VARIABILI CASSA
const btnCestino = document.getElementById('btn-cestino');
const btnCassa = document.getElementById('btn-cassa');
const btnCalcolatrice = document.getElementById('btn-calcolatrice');
const btnClienti = document.getElementById('btn-clienti');
const btnRegistro = document.getElementById('btn-registro');
const btnDipendente = document.getElementById('btn-dipendente');
const btnMacchinetta = document.getElementById('btn-macchinetta');
const btnPreferiti = document.getElementById('btn-preferiti');

const displayTotale = document.getElementById('display-totale');
const areaDati = document.getElementById('area-dati-tabella');
const campoSconto = document.getElementById('campo-sconto');
const campoPagamento = document.getElementById('campo-pagamento');
const campoScheda = document.getElementById('campo-scheda');
const campoBarcode = document.getElementById('campo-barcode');
const listaRicerca = document.getElementById('lista-ricerca');
const btnAnnullaSconto = document.getElementById('btn-annulla-sconto');

const barraCentro = document.getElementById('stat-centro');
const barraCliente = document.getElementById('stat-cliente');
const barraDestra = document.getElementById('stat-destra');
const txtArticoli = document.getElementById('txt-articoli');
const txtPezzi = document.getElementById('txt-pezzi');
const cliSemaforo = document.getElementById('cli-semaforo');
const cliNome = document.getElementById('cli-nome');
const cliPunti = document.getElementById('cli-punti');
const cliBonus = document.getElementById('cli-bonus');

let carrello = []; let clienteAttivo = null; let totaleLordo = 0; let totaleNettoAttuale = 0; let percentualeSconto = 0; let indiceRicercaAttivo = -1; let msgDaInviarePlain = ""; let telClienteAttuale = "";

// ==========================================
// 🚀 INIZIALIZZAZIONE E AVVIO SISTEMA
// ==========================================
let appAppenaAvviata = true;

window.onload = async () => {
    try {
        await initDB();
        mostraMessaggio("CASSA PRONTA");
        campoBarcode.disabled = false;
        campoScheda.disabled = false;

        let pinRichiesto = localStorage.getItem('impostazioni_pin_attivo') !== 'false';

        if (!pinRichiesto) {
            // Se l'impostazione "Richiedi PIN" è disattivata, sblocca in automatico con l'Admin di default
            let adminDefault = listaOperatori.find(op => op.ruolo === 'ADMIN') || listaOperatori[0];
            sbloccaCassaConPin(adminDefault.pin);
        } else {
            // Altrimenti, attiva la nuova schermata di blocco operatore e chiedi il PIN
            bloccaCassa();
        }

        // 🚀 AVVISO FIREBASE INTELLIGENTE
        if (!FIREBASE_URL || FIREBASE_URL === "") {
            setTimeout(() => mostraAvvisoModale("⚠️ <b>Nessun Database Collegato</b><br><br>Vai in <i>Impostazioni -> Impostazioni Sistema</i> e inserisci il link di Firebase per abilitare il salvataggio sul cloud."), 800);
        }

    } catch (e) {
        console.error("Errore inizializzazione DB", e);
        mostraAvvisoModale("Errore durante l'apertura del Database: " + e);
    }
};

// 5. Blocco Cassa (Auto-Logout)
window.bloccaCassa = function () {
    if (operatoreLoggato) registraLogSistema("LOGOUT", `Disconnessione cassa.`);
    operatoreLoggato = null;
    operatoreAttivo = "Nessuno";
    document.getElementById('label-operatore').innerHTML = "🔒 BLOCCATO";
    document.getElementById('input-pin-sblocco').value = "";

    // Chiude tutti i menu e finestre aperte per non farle spiare
    document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
    apriModale('modal-sblocco-cassa');

    // 👇 Posiziona automaticamente il cursore nel campo PIN con un leggero ritardo per l'animazione della modale
    setTimeout(() => document.getElementById('input-pin-sblocco').focus(), 100);
};

// ==========================================
// FUNZIONI MODALI UNIVERSALI E GESTIONE FOCUS
// ==========================================
function apriModale(id) { const el = document.getElementById(id); if (el) el.style.display = 'flex'; }
function chiudiModale(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }

function mostraAvvisoModale(messaggio) {
    document.getElementById('msg-avviso').innerHTML = messaggio;
    apriModale('modal-avviso');
}

// ⌨️ TRUCCO TASTIERA: Permette di chiudere gli avvisi premendo semplicemente INVIO
window.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
        let modaleAvviso = document.getElementById('modal-avviso');
        // Se il modale di avviso giallo è aperto, intercetta l'Invio e chiudilo!
        if (modaleAvviso && modaleAvviso.style.display !== 'none') {
            e.preventDefault(); // Evita che l'invio prema per sbaglio roba in background
            chiudiModaleAvviso();
        }
    }
});

window.chiudiModaleAvviso = function () {
    chiudiModale('modal-avviso');
    // Se c'è la schermata di blocco attiva, rimetti a forza il cursore sul PIN
    let modaleBlocco = document.getElementById('modal-sblocco-cassa');
    if (modaleBlocco && modaleBlocco.style.display !== 'none') {
        setTimeout(() => document.getElementById('input-pin-sblocco').focus(), 100);
    } else {
        // Se siamo in cassa e non ci sono menu aperti, metti il cursore sul barcode
        let campoBarcode = document.getElementById('campo-barcode');
        let modaleMenu = document.getElementById('modal-menu-principale');
        if (campoBarcode && !campoBarcode.disabled && modaleMenu && modaleMenu.style.display === 'none') {
            setTimeout(() => campoBarcode.focus(), 100);
        }
    }
};

// AGGIORNAMENTO SCHERMO
function aggiornaContatori() { txtArticoli.textContent = carrello.length + " ARTICOLI"; let numPezzi = 0; carrello.forEach(p => numPezzi += p.qta); txtPezzi.textContent = numPezzi + " PEZZI"; }
function mostraMessaggio(testo, tipo = "normale") { barraCliente.style.display = 'none'; barraCentro.style.display = 'block'; barraCentro.textContent = testo; if (tipo === "errore") { barraCentro.classList.add('avviso-errore'); } else { barraCentro.classList.remove('avviso-errore'); } }
function aggiornaSchermo() { if (totaleLordo === 0) { displayTotale.value = '€ 0,00'; totaleNettoAttuale = 0; return; } let valoreSconto = totaleLordo * (percentualeSconto / 100); totaleNettoAttuale = totaleLordo - valoreSconto; displayTotale.value = '€ ' + totaleNettoAttuale.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// INSERIMENTO RAPIDO TOTALE
displayTotale.addEventListener('focus', function () { this.value = ''; this.placeholder = '0,00'; });
displayTotale.addEventListener('blur', function () { aggiornaSchermo(); });
displayTotale.addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        let testoDigitato = this.value.trim().replace(',', '.');
        let importo = parseFloat(testoDigitato);
        if (!isNaN(importo) && importo > 0) {
            let prodManuale = { codice: "MAN-" + Math.floor(Math.random() * 1000000), descrizione: "PRODOTTO MANUALE", giacenza: "-", prezzo: importo, categoria: "PM", tipo: "PZ" };
            aggiungiProdotto(prodManuale);
        } else if (testoDigitato !== '') { mostraAvvisoModale("IMPORTO INSERITO NON VALIDO"); }
        this.blur(); campoBarcode.focus();
    }
});

// 🌟 CALCOLATRICE
let calcCategoriaAttiva = ''; let calcSessionTotal = 0;
const displayNumpad = document.getElementById('display-numpad');
const numpadLogList = document.getElementById('numpad-log-list');
const numpadLogTotale = document.getElementById('numpad-log-totale');

// 🌟 CALCOLATRICE E REPARTI DINAMICI
if (btnCalcolatrice) {
    btnCalcolatrice.addEventListener('click', function () {
        disegnaTastiRepartoNumpad();
        apriModale('modal-calc-categorie');
    });
}

// ==========================================
// 🌟 CALCOLATRICE E REPARTI PREFERITI DINAMICI
// ==========================================

// Apre la modale per scegliere i tasti
window.apriConfigurazioneTastiCassa = function () {
    // Recupera tutte le categorie esistenti nel gestionale
    let tutteLeCategorie = typeof getCategorieMagazzino === "function" ? getCategorieMagazzino() : ["VARIE"];
    if (!tutteLeCategorie || tutteLeCategorie.length === 0) tutteLeCategorie = ["VARIE"];

    // Recupera quelle già salvate come "preferite" in passato (se esistono)
    let salvate = JSON.parse(localStorage.getItem('gestionale_reparti_cassa') || "null");
    if (!salvate) salvate = tutteLeCategorie.slice(0, 8); // Se è la prima volta, preseleziona le prime 8

    let container = document.getElementById('lista-check-categorie');
    container.innerHTML = "";

    // Genera la lista con le spunte
    tutteLeCategorie.forEach(cat => {
        let isChecked = salvate.includes(cat) ? "checked" : "";
        container.innerHTML += `
            <label style="display: flex; align-items: center; gap: 15px; font-size: 1.8vh; cursor: pointer; padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.05); transition: background 0.2s;" onmouseover="this.style.background='rgba(255,204,0,0.1)'" onmouseout="this.style.background='transparent'">
                <input type="checkbox" class="check-reparto-rapido" value="${cat}" ${isChecked} style="width: 22px; height: 22px; accent-color: #ffcc00; cursor: pointer;">
                <span style="color: white;">${cat}</span>
            </label>
        `;
    });

    apriModale('modal-config-tasti-cassa');
};

// Salva i tasti scelti
window.salvaConfigurazioneTastiCassa = function () {
    let checkboxes = document.querySelectorAll('.check-reparto-rapido:checked');
    let selezionate = Array.from(checkboxes).map(cb => cb.value);

    if (selezionate.length === 0) {
        mostraAvvisoModale("Devi selezionare almeno un reparto da mostrare nella calcolatrice!");
        return;
    }

    // Salva le preferenze nella memoria fissa del browser
    localStorage.setItem('gestionale_reparti_cassa', JSON.stringify(selezionate));
    chiudiModale('modal-config-tasti-cassa');

    // Ridisegna subito i bottoni nella calcolatrice in tempo reale
    disegnaTastiRepartoNumpad();
};

// Rende i bottoni a schermo
window.disegnaTastiRepartoNumpad = function () {
    let container = document.getElementById('contenitore-tasti-reparto');
    if (!container) return;

    let tutteLeCategorie = typeof getCategorieMagazzino === "function" ? getCategorieMagazzino() : ["VARIE"];
    if (!tutteLeCategorie || tutteLeCategorie.length === 0) tutteLeCategorie = ["VARIE"];

    let preferite = JSON.parse(localStorage.getItem('gestionale_reparti_cassa') || "null");

    // Se non ha mai configurato nulla, mostra le prime 8 categorie in automatico
    if (!preferite) {
        preferite = tutteLeCategorie.slice(0, 8);
    }

    // Filtro di sicurezza: mostra il bottone solo se la categoria esiste ancora nel magazzino
    let categorieDaMostrare = preferite.filter(cat => tutteLeCategorie.includes(cat));
    if (categorieDaMostrare.length === 0) categorieDaMostrare = ["VARIE"];

    let html = "";
    let icone = ["📦", "🛒", "🏷️", "🛍️", "🔖", "💎", "🧴", "🎁", "✨"];

    categorieDaMostrare.forEach((cat, index) => {
        let icona = icone[index % icone.length];

        // Ho aggiunto effetti hover per farli sembrare veri bottoni da cassa Touch
        html += `
            <div class="tasto-fisico tasto-categoria" onclick="apriNumpad('${cat}')" 
                 style="min-width: 130px; flex: 1 1 30%; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100px; cursor: pointer; border: 2px solid #333; border-radius: 8px; background: rgba(255,255,255,0.05); transition: all 0.2s;"
                 onmouseover="this.style.background='rgba(77,136,255,0.2)'; this.style.borderColor='#4d88ff';" 
                 onmouseout="this.style.background='rgba(255,255,255,0.05)'; this.style.borderColor='#333';">
                <span class="icona" style="font-size: 3.5vh; margin-bottom: 8px;">${icona}</span>
                <span class="testo" style="font-size: 1.6vh; text-align: center; word-break: break-word; line-height: 1.2; font-weight: bold; color: #e6e6e6;">${cat}</span>
            </div>
        `;
    });

    container.innerHTML = html;
};

window.apriNumpad = function (categoriaSelezionata) {
    calcCategoriaAttiva = categoriaSelezionata; displayNumpad.value = ''; document.getElementById('titolo-numpad').textContent = "IMPORTO REPARTO " + categoriaSelezionata;
    calcSessionTotal = 0; numpadLogList.innerHTML = ''; numpadLogTotale.textContent = '€ 0,00';
    chiudiModale('modal-calc-categorie'); apriModale('modal-numpad'); setTimeout(() => displayNumpad.focus(), 100);
};

window.digitaNumpad = function (tasto) {
    let valAttuale = displayNumpad.value;
    if (tasto === 'C') { valAttuale = ''; } else if (tasto === ',') { if (!valAttuale.includes(',')) { valAttuale += valAttuale === '' ? '0,' : ','; } } else { if (valAttuale.length < 8) { valAttuale += tasto; } }
    displayNumpad.value = valAttuale; displayNumpad.focus();
};

displayNumpad.addEventListener('input', function () { this.value = this.value.replace(/[^0-9.,]/g, ''); });
displayNumpad.addEventListener('keypress', function (e) { if (e.key === 'Enter') { e.preventDefault(); confermaNumpad(); } });

window.confermaNumpad = function () {
    let testoDigitato = displayNumpad.value.trim().replace(',', '.'); let importo = parseFloat(testoDigitato);
    if (!isNaN(importo) && importo > 0) {
        let prodReparto = { codice: "REP-" + Math.floor(Math.random() * 1000000), descrizione: "REPARTO " + calcCategoriaAttiva, giacenza: "-", prezzo: importo, categoria: calcCategoriaAttiva, tipo: "PZ" };
        aggiungiProdotto(prodReparto);
        calcSessionTotal += importo; numpadLogTotale.textContent = '€ ' + calcSessionTotal.toLocaleString('it-IT', { minimumFractionDigits: 2 });
        let logItem = document.createElement('div'); logItem.className = 'log-item'; logItem.title = "Clicca per annullare l'inserimento";
        logItem.innerHTML = `<span>${calcCategoriaAttiva}</span> <span>€ ${importo.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</span>`;

        logItem.addEventListener('click', function () {
            calcSessionTotal -= importo; if (calcSessionTotal < 0.01) calcSessionTotal = 0; numpadLogTotale.textContent = '€ ' + calcSessionTotal.toLocaleString('it-IT', { minimumFractionDigits: 2 });
            let indexDaEliminare = carrello.findIndex(i => i.codice === prodReparto.codice);
            if (indexDaEliminare > -1) { let item = carrello[indexDaEliminare]; totaleLordo -= item.prezzo; if (totaleLordo < 0.01) totaleLordo = 0; carrello.splice(indexDaEliminare, 1); let rigaMain = document.getElementById('riga-' + prodReparto.codice); if (rigaMain) rigaMain.remove(); aggiornaSchermo(); aggiornaContatori(); }
            this.remove(); displayNumpad.focus();
        });

        numpadLogList.appendChild(logItem); numpadLogList.scrollTop = numpadLogList.scrollHeight; displayNumpad.style.backgroundColor = '#ccffcc'; setTimeout(() => displayNumpad.style.backgroundColor = 'transparent', 200); displayNumpad.value = ''; displayNumpad.focus();
    } else { displayNumpad.style.backgroundColor = '#ffcccc'; setTimeout(() => displayNumpad.style.backgroundColor = 'transparent', 200); }
};

// AGGIUNGI PRODOTTO A CARRELLO E SCHERMO
function aggiungiProdotto(prodotto) {
    // --- NOVITÀ: BLOCCO TESTER ---
    if (prodotto.is_tester) {
        mostraAvvisoModale("<b>ARTICOLO TESTER</b><br><br>Questo articolo è contrassegnato come Tester/Campione e non può essere inserito nello scontrino di vendita.");
        return;
    }

    // 🔥 DEVIATORE PER FORMATI ALLA SPINA
    if (prodotto.is_formato_spina) {
        if (!prodotto.volume_spina || prodotto.volume_spina <= 0) {
            mostraAvvisoModale("Errore: Questo formato alla spina non ha i millilitri configurati in magazzino.");
            return;
        }
        apriModaleScegliEssenza(prodotto);
        return; // Interrompe l'aggiunta normale per aspettare la scelta dell'essenza
    }

    let itemInCart = carrello.find(i => i.codice === prodotto.codice);

    if (itemInCart) {
        itemInCart.qta++; const rigaEsistente = document.getElementById('riga-' + prodotto.codice); rigaEsistente.querySelector('.qta-val').textContent = itemInCart.qta; rigaEsistente.querySelector('.tot-riga-val').textContent = '€ ' + (itemInCart.qta * itemInCart.prezzo).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } else {
        carrello.push({ ...prodotto, qta: 1 }); const nuovaRiga = document.createElement('div'); nuovaRiga.className = 'riga-prodotto'; nuovaRiga.id = 'riga-' + prodotto.codice; nuovaRiga.title = "Clicca per rimuovere 1 pezzo";
        nuovaRiga.innerHTML = `<div class="col-centro">${prodotto.codice.substring(0, 3) === 'MAN' || prodotto.codice.substring(0, 3) === 'REP' ? '0' : prodotto.codice}</div><div class="col-sinistra">${prodotto.descrizione}</div><div class="col-centro">${prodotto.giacenza}</div><div class="col-valuta">€ ${prodotto.prezzo.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div><div class="col-centro qta-val">1</div><div class="col-centro">${prodotto.categoria}</div><div class="col-valuta tot-riga-val">€ ${prodotto.prezzo.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>`;

        nuovaRiga.addEventListener('click', function () {
            let indexDaEliminare = carrello.findIndex(i => i.codice === prodotto.codice);
            if (indexDaEliminare > -1) {
                let item = carrello[indexDaEliminare]; totaleLordo -= item.prezzo; if (totaleLordo < 0.01) totaleLordo = 0;
                if (item.qta > 1) { item.qta--; this.querySelector('.qta-val').textContent = item.qta; this.querySelector('.tot-riga-val').textContent = '€ ' + (item.qta * item.prezzo).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); if (barraCliente.style.display !== 'flex') { mostraMessaggio("RIMOSSO 1 PEZZO: " + item.descrizione); } }
                else { carrello.splice(indexDaEliminare, 1); this.remove(); if (barraCliente.style.display !== 'flex') { mostraMessaggio("ARTICOLO RIMOSSO: " + item.descrizione); } }
                aggiornaSchermo(); aggiornaContatori(); if (document.getElementById('modal-numpad').style.display !== 'flex') { campoBarcode.focus(); }
            }
        });
        areaDati.appendChild(nuovaRiga); areaDati.scrollTop = areaDati.scrollHeight;
    }
    totaleLordo += prodotto.prezzo; aggiornaSchermo(); aggiornaContatori(); campoBarcode.value = ''; listaRicerca.style.display = 'none'; indiceRicercaAttivo = -1;
    if (barraCliente.style.display !== 'flex') { mostraMessaggio("INSERITO: " + prodotto.descrizione); }
    if (document.getElementById('modal-numpad').style.display !== 'flex') { campoBarcode.focus(); }
}

// RICERCA CLIENTE
async function eseguiRicercaCliente(valoreInserito) {
    clienteAttivo = await getBySchedaOTelefono(valoreInserito);
    if (clienteAttivo) {
        barraCentro.style.display = 'none'; barraCentro.classList.remove('avviso-errore'); barraCliente.style.display = 'flex';
        cliNome.textContent = clienteAttivo.nome; cliPunti.textContent = clienteAttivo.punti.toLocaleString('it-IT', { maximumFractionDigits: 2 }); cliBonus.textContent = clienteAttivo.bonus.toLocaleString('it-IT', { minimumFractionDigits: 2 });
        const oggi = new Date(); const dataOperazione = new Date(clienteAttivo.dataUltimaOperazione); const differenzaGiorni = Math.floor((oggi - dataOperazione) / (1000 * 60 * 60 * 24));
        if (differenzaGiorni <= 30) { cliSemaforo.textContent = '🟢'; } else if (differenzaGiorni <= 60) { cliSemaforo.textContent = '🟡'; } else { cliSemaforo.textContent = '🔴'; } campoBarcode.focus();
    } else { clienteAttivo = null; mostraAvvisoModale("NESSUN CLIENTE TROVATO CON QUESTO NUMERO O SCHEDA."); }
}

campoScheda.addEventListener('input', function () { this.value = this.value.replace(/[^0-9]/g, ''); if (this.value.length === 10 || this.value.length === 13) { eseguiRicercaCliente(this.value); } else { clienteAttivo = null; if (barraCliente.style.display === 'flex') { mostraMessaggio("CASSA PRONTA"); } } });
campoScheda.addEventListener('keypress', function (e) { if (e.key === 'Enter') { eseguiRicercaCliente(this.value.trim()); } });
campoScheda.addEventListener('mouseenter', function () { this.focus(); }); campoBarcode.addEventListener('mouseenter', function () { this.focus(); });

// ==========================================
// ⭐ MOTORE CALCOLO PUNTI E SOGLIE DINAMICHE
// ==========================================
window.calcolaPuntiSpesa = function (bonusApplicato = 0) {
    let puntiGuadagnati = 0;

    // Legge le regole. Se il pannello non è mai stato salvato, applica un salvagente di default
    let regoleSalvate = localStorage.getItem('crm_soglie_punti');
    let regole = regoleSalvate ? JSON.parse(regoleSalvate) : { "DEFAULT": 0.25 };

    // Se non esiste una regola "DEFAULT", usa 0.25
    let moltiplicatoreDefault = regole["DEFAULT"] !== undefined ? parseFloat(regole["DEFAULT"]) : 0.25;

    carrello.forEach(item => {
        // 1. GERARCHIA ASSOLUTA: Se nell'anagrafica hai forzato un punto fedeltà fisso, vince lui!
        if (item.punti_fedelta && parseFloat(item.punti_fedelta) > 0) {
            puntiGuadagnati += (parseFloat(item.punti_fedelta) * item.qta);
        } else {
            // 2. REGOLA DI CATEGORIA: Cerca la categoria esatta del prodotto
            let prezzoScontatoRiga = (item.prezzo * item.qta) * (1 - (percentualeSconto || 0) / 100);
            let cat = (item.categoria || "").toUpperCase();

            // Se la categoria esiste nelle regole, usa il suo moltiplicatore, altrimenti usa il Default
            let moltiplicatore = regole[cat] !== undefined ? parseFloat(regole[cat]) : moltiplicatoreDefault;

            puntiGuadagnati += prezzoScontatoRiga * moltiplicatore;
        }
    });

    // 3. Proporzione in caso di pagamento parziale con Bonus
    if (bonusApplicato > 0 && totaleNettoAttuale > 0) {
        let rapportoNettoSuLordo = (totaleNettoAttuale - bonusApplicato) / totaleNettoAttuale;
        puntiGuadagnati = puntiGuadagnati * rapportoNettoSuLordo;
    }

    return parseFloat(puntiGuadagnati.toFixed(2));
};

// 2. Variabile temporanea per la gestione a schermo
let tempSogliePunti = {};

// 3. Apre il modale e disegna la lista
window.apriGestioneSogliePunti = function () {
    let salvate = localStorage.getItem('crm_soglie_punti');
    tempSogliePunti = salvate ? JSON.parse(salvate) : { "CBD": 1, "PM": 1, "HHC": 0.5, "DEFAULT": 0.25 };

    disegnaListaSogliePunti();
    chiudiModale('modal-impostazioni-menu');
    apriModale('modal-impostazioni-soglie');
};

// 4. Disegna le righe nella tabella
function disegnaListaSogliePunti() {
    let html = "";
    for (let cat in tempSogliePunti) {
        let isDefault = (cat === "DEFAULT");
        let tastoElimina = isDefault ?
            `<span style="color: #666; font-size: 1.2vh;">Fisso</span>` :
            `<button onclick="eliminaSogliaPunti('${cat}')" style="background: rgba(255,77,77,0.2); border: 1px solid #ff4d4d; color: #ff4d4d; border-radius: 4px; cursor: pointer; padding: 2px 8px;">❌</button>`;

        html += `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.1);">
                <div style="flex: 2; font-weight: bold; color: ${isDefault ? '#b3d9ff' : 'white'};">${isDefault ? 'TUTTO IL RESTO (DEFAULT)' : cat}</div>
                <div style="flex: 1; text-align: center; color: #00ffcc; font-weight: bold;">x ${tempSogliePunti[cat]}</div>
                <div style="flex: 0.5; text-align: right;">${tastoElimina}</div>
            </div>
        `;
    }
    document.getElementById('lista-soglie-punti').innerHTML = html;
};

// 5. Aggiunge o aggiorna una regola
window.aggiungiSogliaPunti = function () {
    let cat = document.getElementById('nuova-soglia-cat').value.trim().toUpperCase();
    let valString = document.getElementById('nuova-soglia-val').value.trim().replace(',', '.');
    let val = parseFloat(valString);

    if (cat === "") {
        mostraAvvisoModale("Inserisci il nome della categoria.");
        return;
    }
    if (isNaN(val) || val < 0) {
        mostraAvvisoModale("Inserisci un moltiplicatore valido (es. 1 o 0.5).");
        return;
    }

    tempSogliePunti[cat] = val; // Aggiunge o sovrascrive
    document.getElementById('nuova-soglia-cat').value = "";
    document.getElementById('nuova-soglia-val').value = "";
    disegnaListaSogliePunti();
};

// 6. Elimina una regola
window.eliminaSogliaPunti = function (cat) {
    if (cat === "DEFAULT") return; // Sicurezza
    delete tempSogliePunti[cat];
    disegnaListaSogliePunti();
};

// 7. Salva permanentemente
window.salvaSogliePunti = function () {
    // Ci assicuriamo che la categoria DEFAULT esista sempre
    if (tempSogliePunti["DEFAULT"] === undefined) tempSogliePunti["DEFAULT"] = 0.25;

    localStorage.setItem('crm_soglie_punti', JSON.stringify(tempSogliePunti));

    mostraAvvisoModale("Soglie punti aggiornate con successo!");
    chiudiModale('modal-impostazioni-soglie');
    apriModale('modal-impostazioni-menu');
};

// TASTO CASSA
if (btnCassa) {
    btnCassa.addEventListener('click', function () {
        // 1. Controllo Scontrino Vuoto
        if (carrello.length === 0) {
            mostraAvvisoModale("SCONTRINO VUOTO.<br>Aggiungi almeno un articolo.");
            return;
        }

        // 2. Controllo Pagamento (IGNORATO SE IL TOTALE È NEGATIVO O ZERO)
        if (totaleNettoAttuale > 0 && campoPagamento.value.trim() === "") {
            mostraAvvisoModale("ATTENZIONE:<br>Seleziona un METODO DI PAGAMENTO (Contanti o POS) prima di chiudere lo scontrino.");
            return;
        }

        // 3. Controllo Bonus Cliente
        if (clienteAttivo && clienteAttivo.bonus > 0 && totaleNettoAttuale > 0) {
            document.getElementById('mod-totale').textContent = '€ ' + totaleNettoAttuale.toLocaleString('it-IT', { minimumFractionDigits: 2 });
            document.getElementById('mod-bonus').textContent = '- € ' + clienteAttivo.bonus.toLocaleString('it-IT', { minimumFractionDigits: 2 });
            let netto = totaleNettoAttuale - clienteAttivo.bonus;
            document.getElementById('mod-netto').textContent = '€ ' + netto.toLocaleString('it-IT', { minimumFractionDigits: 2 });
            apriModale('modal-riscatto');
        } else {
            confermaVendita(false);
        }
    });
}

window.confermaVendita = async function (riscattaBonus) {
    let tipoPagamento = campoPagamento.value || "CONTANTI";

    // --- INTERCETTA PAGAMENTO MISTO ---
    if (tipoPagamento === "Misto" && !isRiscattoMistoPendete) {
        chiudiModale('modal-riscatto');

        let bonusUsato = (riscattaBonus && clienteAttivo) ? clienteAttivo.bonus : 0;
        let daPagare = totaleNettoAttuale - bonusUsato;

        if (daPagare > 0) {
            document.getElementById('misto-totale-da-pagare').textContent = '€ ' + daPagare.toLocaleString('it-IT', { minimumFractionDigits: 2 });
            document.getElementById('misto-contanti').value = '';
            document.getElementById('misto-pos').value = '';

            document.getElementById('modal-pagamento-misto').dataset.riscattaBonus = riscattaBonus ? 'true' : 'false';
            document.getElementById('modal-pagamento-misto').dataset.daPagare = daPagare;

            apriModale('modal-pagamento-misto');
            setTimeout(() => document.getElementById('misto-contanti').focus(), 100);
            return; // Ferma il salvataggio finché non divide gli importi
        }
    }
    isRiscattoMistoPendete = false; // Reset

    if (riscattaBonus) {
        if (clienteAttivo && clienteAttivo.bonus > totaleNettoAttuale) {
            chiudiModale('modal-riscatto');
            apriModale('modal-saldo-negativo');
            return;
        }
    }
    chiudiModale('modal-riscatto');

    let messaggioEsito = "";
    let bonusUsato = (riscattaBonus && clienteAttivo) ? clienteAttivo.bonus : 0;
    let pagato = totaleNettoAttuale - bonusUsato;

    // --- NUOVA LOGICA VOUCHER ---
    let importoVoucherGenerato = 0;
    let codiceVoucherGenerato = null;

    if (pagato < 0) {
        importoVoucherGenerato = Math.abs(pagato);
        codiceVoucherGenerato = "VOU" + Date.now().toString().slice(-5) + Math.floor(Math.random() * 1000);

        let txV = db.transaction('vouchers', 'readwrite');
        txV.objectStore('vouchers').put({
            codice: codiceVoucherGenerato,
            importo: importoVoucherGenerato,
            dataEmissione: getOggiString()
        });

        pagato = 0; // Contabilmente il cliente non paga nulla
        salvaVoucherCloud({ codice: codiceVoucherGenerato, importo: importoVoucherGenerato, dataEmissione: getOggiString() });
    }

    // --- RESET TESTI MODALE ESITO ---
    let titoloModale = document.getElementById('titolo-modal-esito');
    if (titoloModale) titoloModale.innerHTML = importoVoucherGenerato > 0 ? "🎟️ RESO E VOUCHER EMESSO" : "✅ VENDITA COMPLETATA";
    let btnChiudi = document.getElementById('btn-chiudi-esito');
    if (btnChiudi) btnChiudi.innerHTML = "NUOVO CLIENTE E CHIUDI";

    let saldoIniziale = clienteAttivo ? clienteAttivo.punti : 0;
    let puntiAcquisiti = 0; let puntiSpesi = 0; let saldoFinale = saldoIniziale; let dataDiOggiStr = getOggiString();

    if (clienteAttivo) {
        puntiAcquisiti = calcolaPuntiSpesa(bonusUsato);
        let puntiString = puntiAcquisiti.toLocaleString('it-IT', { maximumFractionDigits: 2 });

        if (riscattaBonus) {
            puntiSpesi = clienteAttivo.bonus * 10;
            clienteAttivo.punti -= puntiSpesi;
            clienteAttivo.punti += puntiAcquisiti;
            clienteAttivo.bonus = Math.floor(clienteAttivo.punti / 100) * 10;
            clienteAttivo.dataUltimaOperazione = dataDiOggiStr;
            saldoFinale = clienteAttivo.punti;
            messaggioEsito = `Scontrino emesso riscattando il bonus.<br><br>Punti spesi: <b style="color:#ff6666;">⭐ -${puntiSpesi}</b><br>Punti guadagnati: <b style="color:#00cc66;">⭐ +${puntiString}</b><br><br>Nuovo saldo punti: <b>⭐ ${clienteAttivo.punti.toLocaleString('it-IT', { maximumFractionDigits: 2 })}</b>`;
        } else {
            clienteAttivo.punti += puntiAcquisiti;
            clienteAttivo.bonus = Math.floor(clienteAttivo.punti / 100) * 10;
            clienteAttivo.dataUltimaOperazione = dataDiOggiStr;
            saldoFinale = clienteAttivo.punti;
            messaggioEsito = `Scontrino emesso.<br><br>Punti guadagnati: <b style="color:#00cc66;">⭐ +${puntiString}</b><br><br>Nuovo saldo punti: <b>⭐ ${clienteAttivo.punti.toLocaleString('it-IT', { maximumFractionDigits: 2 })}</b>`;
        }
        await updateCliente(clienteAttivo);
        aggiornaFidelityFirebase(clienteAttivo.scheda, clienteAttivo.punti, dataDiOggiStr);

        window.datiNotificaApp = {
            scheda: clienteAttivo.scheda, saldoIniziale: saldoIniziale, puntiAcquisiti: puntiAcquisiti, puntiSpesi: puntiSpesi, saldoFinale: saldoFinale, bonus: clienteAttivo.bonus
        };
        telClienteAttuale = clienteAttivo.telefono;

        // --- COMPILAZIONE MESSAGGIO WHATSAPP/TELEGRAM ---
        let msgSalvato = localStorage.getItem('impostazioni_msg_template');
        let templateMsg = msgSalvato ? msgSalvato : "CHEMARIA FIDELITY\n\nCiao, {NOME}\n\nCard N: {SCHEDA}\n\n-------------------------\n* Saldo Iniziale: {SALDO_INIZIALE}\n\n* Punti Caricati: {PUNTI_CARICATI}\n\n* Punti Scaricati: {PUNTI_SCARICATI}\n\n* Saldo Punti: {PUNTI}\n\n* Bonus: € {BONUS}\n-------------------------\n\n{DATA}\n{ORA}";

        let strData = `${dataDiOggiStr.split('-').reverse().join('/')}`;
        let d = new Date();
        let strOra = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

        msgDaInviarePlain = templateMsg
            .replace(/{NOME}/g, clienteAttivo.nome)
            .replace(/{SCHEDA}/g, clienteAttivo.scheda)
            .replace(/{SALDO_INIZIALE}/g, saldoIniziale.toLocaleString('it-IT', { minimumFractionDigits: 2 }))
            .replace(/{PUNTI_CARICATI}/g, puntiAcquisiti.toLocaleString('it-IT', { minimumFractionDigits: 2 }))
            .replace(/{PUNTI_SCARICATI}/g, puntiSpesi.toLocaleString('it-IT', { minimumFractionDigits: 2 }))
            .replace(/{PUNTI}/g, saldoFinale.toLocaleString('it-IT', { minimumFractionDigits: 2 }))
            .replace(/{BONUS}/g, clienteAttivo.bonus.toLocaleString('it-IT', { minimumFractionDigits: 2 }))
            .replace(/{DATA}/g, strData)
            .replace(/{ORA}/g, strOra);

        // --- RESET TASTO NOTIFICA APP ---
        let btnApp = document.getElementById('btn-invia-app');
        if (btnApp) {
            btnApp.innerHTML = '📱 Notifica App';
            btnApp.classList.remove('inviato');
        }

        document.getElementById('box-notifiche').style.display = 'block';
    } else {
        messaggioEsito = "Operazione completata (Cliente non registrato).";
        document.getElementById('box-notifiche').style.display = 'none';
    }

    // --- AGGIUNTA TESTO VOUCHER NELL'ESITO ---
    if (importoVoucherGenerato > 0) {
        messaggioEsito = `<span style="color:#ffcc00; font-size:2.2vh; font-weight:bold;">È stato generato un Buono Reso di € ${importoVoucherGenerato.toFixed(2).replace('.', ',')}</span><br><br>La stampa termica del ticket partirà in automatico.<br><br>` + messaggioEsito;
        stampaVoucherTermico(codiceVoucherGenerato, importoVoucherGenerato);
    }

    let d = new Date(); let hh = String(d.getHours()).padStart(2, '0'); let min = String(d.getMinutes()).padStart(2, '0');

    let recordVendita = {
        id: Date.now(),
        CLIENTE: clienteAttivo ? clienteAttivo.nome : "Nessuno",
        OPERATORE: operatoreAttivo,
        GIORNO: dataDiOggiStr,
        ORA: `${hh}:${min}`,
        CONTANTI: tipoPagamento.toUpperCase() === "CONTANTI" ? pagato : (tipoPagamento === "Misto" ? importoMistoContanti : 0),
        POS: tipoPagamento.toUpperCase() === "POS" ? pagato : (tipoPagamento === "Misto" ? importoMistoPos : 0),
        PUNTI_CARICATI: puntiAcquisiti,
        PUNTI_SCARICATI: puntiSpesi,
        BONUS: bonusUsato,
        SALDO_PUNTI_INIZIALE: saldoIniziale,
        SALDO_PUNTI_FINALE: saldoFinale,
        ARTICOLI: carrello.map(item => ({
            CODICE: item.codice,
            ARTICOLO: item.descrizione,
            DESCRIZIONE: item.descrizione,
            TIPO: item.tipo || "PZ",
            IMPORTO: item.prezzo * item.qta,
            QUANTITA: item.qta,
            CATEGORIA: item.categoria,
            IVA: item.iva || 22
        }))
    };

    // 🔥 GESTIONE INVENTARIO, BRUCIATURA VOUCHER E SCALO GIFT CARD
    let txMag = db.transaction(['magazzino', 'vouchers', 'giftcards'], 'readwrite');
    let storeMag = txMag.objectStore('magazzino');
    let storeVou = txMag.objectStore('vouchers');
    let storeGC = txMag.objectStore('giftcards');

    for (let item of carrello) {
        if (item.is_kit && item.tipo_kit === 'DINAMICO' && item.componenti_kit) {
            item.componenti_kit.forEach(comp => {
                let reqComp = storeMag.get(comp.codice);
                reqComp.onsuccess = function () {
                    if (reqComp.result) {
                        let compDB = reqComp.result;
                        let quantitaTotaleDaScalare = comp.qta * item.qta;

                        // Richiama il nuovo motore FIFO che restituisce i lotti usati
                        let tracciabilita = scaricaLottiFIFO(compDB, quantitaTotaleDaScalare);

                        // Salva la tracciabilità nel record dell'articolo venduto per la ricerca inversa
                        item.lotti_scaricati = item.lotti_scaricati || [];
                        item.lotti_scaricati.push({ componente: compDB.descrizione, lotti: tracciabilita });

                        // 🔥 PREPARAZIONE ETICHETTA NORMATIVA AL CHECKOUT
                        if (compDB.formato === 'ml' || compDB.inci) {
                            let lottoPrincipale = tracciabilita.length > 0 ? tracciabilita[0].lotto : "N/D";
                            let paoReale = 36; // Default
                            if (compDB.lotti) {
                                let lObj = compDB.lotti.find(lx => lx.codice_lotto === lottoPrincipale);
                                if (lObj && lObj.pao_mesi) paoReale = lObj.pao_mesi;
                            }

                            if (!window.etichetteCheckout) window.etichetteCheckout = [];
                            window.etichetteCheckout.push({
                                nome_profumo: item.descrizione,
                                formato_ml: comp.qta,
                                prezzo: item.prezzo,
                                barcode: item.codice,
                                inci: compDB.inci || "INCI NON INSERITO",
                                lotto: lottoPrincipale,
                                pao: paoReale,
                                copie: item.qta
                            });
                        }

                        storeMag.put(compDB);
                    }
                }
            });
        }
        if (item.categoria === "VOUCHER") {
            storeVou.delete(item.codice); // Brucia il voucher
            eliminaVoucherCloud(item.codice);
        } else if (item.is_giftcard_uso) {
            // SCALO CREDITO GIFT CARD E REGISTRAZIONE STORICO
            let reqGC = storeGC.get(item.codice);
            reqGC.onsuccess = function () {
                if (reqGC.result) {
                    let gc = reqGC.result;
                    gc.saldo -= Math.abs(item.prezzo);

                    if (!gc.storico) gc.storico = [];
                    gc.storico.push({
                        data: getOggiString(),
                        ora: `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`,
                        importo: -Math.abs(item.prezzo),
                        tipo: "ACQUISTO IN CASSA"
                    });

                    if (gc.saldo <= 0.01) { gc.saldo = 0; gc.stato = "ESAURITA"; }
                    storeGC.put(gc);
                    if (typeof salvaGiftCardCloud === "function") salvaGiftCardCloud(gc);
                }
            };
        } else if (item.is_giftcard_ricarica) {
            // INCREMENTO CREDITO GIFT CARD (RICARICA) E REGISTRAZIONE STORICO
            let reqGC = storeGC.get(item.codice_gc_originale);
            reqGC.onsuccess = function () {
                if (reqGC.result) {
                    let gc = reqGC.result;
                    gc.saldo += Math.abs(item.prezzo);
                    gc.stato = "ATTIVA"; // Riattiva la carta se era esaurita o scaduta

                    // Rinnova la scadenza di 12 mesi dalla ricarica!
                    gc.scadenza = getScadenzaGiftCard();

                    if (!gc.storico) gc.storico = [];
                    gc.storico.push({
                        data: getOggiString(),
                        ora: `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`,
                        importo: Math.abs(item.prezzo),
                        tipo: "RICARICA CREDITO"
                    });

                    storeGC.put(gc);
                    if (typeof salvaGiftCardCloud === "function") salvaGiftCardCloud(gc);
                }
            };
        } else if (item.is_reso && item.reso_stato === 'RIVENDIBILE') {
            // Carico Reso: la merce intatta torna a scaffale
            let req = storeMag.get(item.codice_originale || item.codice);
            req.onsuccess = function () {
                if (req.result) { req.result.giacenza += item.qta; storeMag.put(req.result); }
            }
        } else if (!item.is_reso && item.codice !== 'PUNTI' && !item.codice.startsWith('MAN-') && !item.codice.startsWith('REP-') && !item.is_giftcard) {
            // Scarico Vendita
            let req = storeMag.get(item.codice);
            req.onsuccess = function () {
                if (req.result) {
                    let prodotto = req.result;
                    // ⚠️ FIX REINTEGRATO: RIESPLOSIONE KIT DINAMICI
                    if (prodotto.is_kit && prodotto.tipo_kit === 'DINAMICO' && prodotto.componenti_kit) {
                        prodotto.componenti_kit.forEach(comp => {
                            let reqComp = storeMag.get(comp.codice);
                            reqComp.onsuccess = function () {
                                if (reqComp.result) {
                                    reqComp.result.giacenza -= (comp.qta * item.qta);
                                    storeMag.put(reqComp.result);
                                }
                            }
                        });
                    } else {
                        // Articolo normale o Kit Statico
                        prodotto.giacenza -= item.qta;
                        storeMag.put(prodotto);
                    }
                }
            }
        }
    }

    // ==========================================
    // --- EMISSIONE GIFT CARD ---
    // ==========================================
    let giftCardsDaStampare = carrello.filter(item => item.is_giftcard);
    giftCardsDaStampare.forEach((gcItem, index) => {
        let nuovaGC = {
            codice: gcItem.codice,
            importoIniziale: gcItem.prezzo,
            saldo: gcItem.prezzo,
            dataEmissione: getOggiString(),
            scadenza: getScadenzaGiftCard(),
            stato: "ATTIVA"
        };

        let txGC = db.transaction('giftcards', 'readwrite');
        txGC.objectStore('giftcards').put(nuovaGC);
        if (typeof salvaGiftCardCloud === "function") salvaGiftCardCloud(nuovaGC);

        // Ritarda la stampa della Gift Card di 3 secondi per dare il tempo
        // all'operatore di strappare prima lo scontrino di cassa standard
        setTimeout(() => stampaTicketGiftCard(nuovaGC), 3000 + (index * 2000));
    });
    // ==========================================

    await salvaVendita(recordVendita);
    inviaVenditaLive(recordVendita);

    document.getElementById('msg-esito-punti').innerHTML = messaggioEsito;
    apriModale('modal-esito');

    // 🔥 TRIGGER AUTOMATICO STAMPANTE TERMICA ETICHETTE
    if (window.etichetteCheckout && window.etichetteCheckout.length > 0) {
        setTimeout(() => {
            stampaEtichetteNormativeCheckout(window.etichetteCheckout);
            window.etichetteCheckout = []; // Svuota la memoria dopo la stampa
        }, 1500); // Attende 1.5 secondi per permettere prima l'uscita dello scontrino
    }
};

window.inviaWhatsApp = function () {
    if (!telClienteAttuale) return;
    let num = telClienteAttuale.replace(/[^0-9]/g, '');
    if (num.length <= 10 && !num.startsWith('39')) num = '39' + num;
    
    let url = `whatsapp://send?phone=${num}&text=${encodeURIComponent(msgDaInviarePlain)}`;
    window.location.href = url;
};

window.inviaTelegram = function () {
    if (!telClienteAttuale) return;
    let num = telClienteAttuale.replace(/[^0-9]/g, '');
    if (num.length <= 10 && !num.startsWith('39')) num = '39' + num;
    window.open(`https://t.me/+${num}?text=${encodeURIComponent(msgDaInviarePlain)}`, '_blank');
};

window.inviaApp = async function () {
    let btn = document.getElementById('btn-invia-app');
    if (btn.classList.contains('inviato')) return;

    btn.innerHTML = '⏳ Invio in corso...';

    // Invia fisicamente i dati a Firebase
    if (window.datiNotificaApp) {
        await firebasePushNotifiche(
            window.datiNotificaApp.scheda,
            window.datiNotificaApp.saldoIniziale,
            window.datiNotificaApp.puntiAcquisiti,
            window.datiNotificaApp.puntiSpesi,
            window.datiNotificaApp.saldoFinale,
            window.datiNotificaApp.bonus
        );
    }

    btn.innerHTML = '✅ Inviato con successo';
    btn.classList.add('inviato');
};
window.chiudiModaleEsito = function () { chiudiModale('modal-esito'); if (btnCestino) btnCestino.click(); }

// RICERCA PRODOTTO DB
campoBarcode.addEventListener('input', async function () {
    const testo = this.value.toLowerCase().trim();
    listaRicerca.innerHTML = '';
    indiceRicercaAttivo = -1;
    if (testo.length < 2) { listaRicerca.style.display = 'none'; return; }

    const magazzinoGrezzo = await getAll('magazzino');
    const magazzinoCompleto = calcolaGiacenzeVirtualiBOM(magazzinoGrezzo); // Ricalcola BOM

    const risultati = magazzinoCompleto.filter(p => p.codice.toLowerCase().includes(testo) || p.descrizione.toLowerCase().includes(testo));
    if (risultati.length > 0) {
        listaRicerca.style.display = 'flex';
        risultati.forEach(p => {
            const div = document.createElement('div'); div.className = 'voce-lista';
            div.textContent = `${p.codice} - ${p.descrizione} (€ ${p.prezzo.toLocaleString('it-IT', { minimumFractionDigits: 2 })})`;
            div.addEventListener('click', () => aggiungiProdotto(p));
            listaRicerca.appendChild(div);
        });
    } else {
        listaRicerca.style.display = 'none';
    }
});

campoBarcode.addEventListener('keydown', async function (e) {
    let elementi = listaRicerca.querySelectorAll('.voce-lista');
    if (listaRicerca.style.display === 'none' || elementi.length === 0) {
        if (e.key === 'Enter') {
            e.preventDefault();
            const codice = this.value.trim();
            const magazzinoGrezzo = await getAll('magazzino');
            const magazzinoCompleto = calcolaGiacenzeVirtualiBOM(magazzinoGrezzo); // Ricalcola BOM
            const prodotto = magazzinoCompleto.find(p => p.codice === codice);

            if (prodotto) {
                aggiungiProdotto(prodotto);
            } else if (codice.length > 0) {
                mostraAvvisoModale("PRODOTTO NON TROVATO A MAGAZZINO");
                this.value = '';
            }
        }
        return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); indiceRicercaAttivo++; if (indiceRicercaAttivo >= elementi.length) indiceRicercaAttivo = 0; evidenziaVoce(elementi); } else if (e.key === 'ArrowUp') { e.preventDefault(); indiceRicercaAttivo--; if (indiceRicercaAttivo < 0) indiceRicercaAttivo = elementi.length - 1; evidenziaVoce(elementi); } else if (e.key === 'Enter') { e.preventDefault(); if (indiceRicercaAttivo > -1) elementi[indiceRicercaAttivo].click(); }
});

function evidenziaVoce(elementi) { elementi.forEach(el => el.classList.remove('voce-evidenziata')); if (indiceRicercaAttivo > -1) { elementi[indiceRicercaAttivo].classList.add('voce-evidenziata'); elementi[indiceRicercaAttivo].scrollIntoView({ block: "nearest" }); } }
document.querySelectorAll('.opt-sconto').forEach(opt => {
    opt.addEventListener('click', function () {
        let percScelta = parseInt(this.getAttribute('data-sconto'));

        // 🔥 CONTROLLO SICUREZZA SCONTO
        if (operatoreLoggato && percScelta > operatoreLoggato.max_sconto) {
            mostraAvvisoModale(`⛔ <b>LIMITE SUPERATO</b><br><br>Il tuo ruolo (${operatoreLoggato.ruolo}) ti permette di applicare uno sconto massimo del <b>${operatoreLoggato.max_sconto}%</b>.<br><br>Richiedi l'intervento di un Manager.`);
            registraLogSistema("TENTATO SCONTO EXTRALIMITE", `Tentato ${percScelta}%. Limite: ${operatoreLoggato.max_sconto}%`);
            return;
        }

        percentualeSconto = percScelta;
        campoSconto.value = "- " + percentualeSconto + "%";
        campoSconto.style.color = "#cc0000";
        btnAnnullaSconto.style.display = "block";
        aggiornaSchermo();
        registraLogSistema("SCONTO APPLICATO", `Sconto del ${percentualeSconto}% sull'intero scontrino.`);
    });
});
btnAnnullaSconto.addEventListener('click', function () { percentualeSconto = 0; campoSconto.value = ""; campoSconto.style.color = "#000033"; this.style.display = "none"; aggiornaSchermo(); });
document.querySelectorAll('.opt-pagamento').forEach(opt => { opt.addEventListener('click', function () { campoPagamento.value = this.textContent; barraDestra.textContent = this.getAttribute('data-icona'); }); });

if (btnCestino) { btnCestino.addEventListener('click', function () { areaDati.innerHTML = ''; carrello = []; clienteAttivo = null; totaleLordo = 0; totaleNettoAttuale = 0; percentualeSconto = 0; campoSconto.value = ''; campoSconto.style.color = "#000033"; btnAnnullaSconto.style.display = "none"; campoPagamento.value = ''; campoScheda.value = ''; campoBarcode.value = ''; barraDestra.textContent = ''; listaRicerca.style.display = 'none'; barraCliente.style.display = 'none'; barraCentro.style.display = 'block'; mostraMessaggio("CASSA PRONTA"); aggiornaSchermo(); aggiornaContatori(); campoBarcode.focus(); }); }

// 🌟 GESTIONE PREFERITI (PUNTI MANUALI)
const inPuntiCliente = document.getElementById('man-punti-cliente'); const inPuntiValore = document.getElementById('man-punti-valore'); const inPuntiData = document.getElementById('man-punti-data'); const boxManInfo = document.getElementById('man-info-box'); const lblManNome = document.getElementById('man-info-nome'); const lblManPunti = document.getElementById('man-info-punti'); const lblManBonus = document.getElementById('man-info-bonus');
let clienteManualeScelto = null;

if (btnPreferiti) {
    btnPreferiti.addEventListener('click', function () {
        inPuntiCliente.value = ''; inPuntiValore.value = ''; inPuntiData.value = getOggiString(); boxManInfo.style.display = 'none'; clienteManualeScelto = null;

        // --- NOVITÀ: Carica le categorie dinamiche dal Database ---
        let selectCat = document.getElementById('man-punti-categoria');
        if (selectCat) {
            selectCat.innerHTML = '<option value="DIRETTO">Assegnazione Esatta (Nessun Calcolo)</option>';
            let regoleSalvate = localStorage.getItem('crm_soglie_punti');
            let regole = regoleSalvate ? JSON.parse(regoleSalvate) : { "CBD": 1, "PM": 1, "HHC": 0.5, "DEFAULT": 0.25 };
            for (let cat in regole) {
                let label = cat === "DEFAULT" ? "TUTTO IL RESTO (DEFAULT)" : cat;
                selectCat.innerHTML += `<option value="${cat}">${label} (Moltiplica x${regole[cat]})</option>`;
            }
        }
        // ----------------------------------------------------------

        apriModale('modal-punti-manuali'); setTimeout(() => inPuntiCliente.focus(), 100);
    });
}

window.incollaTelefonoPunti = function () {
    if (campoScheda.value !== '') { inPuntiCliente.value = campoScheda.value; cercaClientePerPuntiManuali(campoScheda.value); }
};

if (inPuntiCliente) {
    inPuntiCliente.addEventListener('input', function () {
        this.value = this.value.replace(/[^0-9]/g, '');
        if (this.value.length === 10 || this.value.length === 13) { cercaClientePerPuntiManuali(this.value); } else { boxManInfo.style.display = 'none'; clienteManualeScelto = null; inPuntiCliente.style.backgroundColor = '#ffffff'; }
    });
}

async function cercaClientePerPuntiManuali(valore) {
    let c = await getBySchedaOTelefono(valore);
    if (c) {
        clienteManualeScelto = c; lblManNome.textContent = c.nome; lblManPunti.textContent = c.punti.toLocaleString('it-IT', { maximumFractionDigits: 2 }); lblManBonus.textContent = "€ " + c.bonus.toLocaleString('it-IT', { minimumFractionDigits: 2 }); boxManInfo.style.display = 'block'; inPuntiCliente.style.backgroundColor = '#ccffcc'; inPuntiValore.focus();
    } else { inPuntiCliente.style.backgroundColor = '#ffcccc'; boxManInfo.style.display = 'none'; clienteManualeScelto = null; }
}

window.applicaPuntiManuali = async function (azione) {
    let valoreString = inPuntiValore.value.trim().replace(',', '.');
    let valoreInserito = parseFloat(valoreString);

    if (!clienteManualeScelto) { mostraAvvisoModale("Seleziona prima un cliente valido!"); return; }
    if (isNaN(valoreInserito) || valoreInserito <= 0) { mostraAvvisoModale("Inserisci un valore numerico valido!"); return; }
    if (!inPuntiData.value) { mostraAvvisoModale("Seleziona una data!"); return; }

    // --- Calcolo Dinamico dei Punti in base alla Categoria ---
    let catSelezionata = document.getElementById('man-punti-categoria') ? document.getElementById('man-punti-categoria').value : "DIRETTO";
    let moltiplicatore = 1; // Default per assegnazione esatta

    // Il moltiplicatore si applica SOLO in fase di CARICO. Lo scarico è sempre 1 a 1.
    if (azione === 'CARICA' && catSelezionata !== "DIRETTO") {
        let regoleSalvate = localStorage.getItem('crm_soglie_punti');
        let regole = regoleSalvate ? JSON.parse(regoleSalvate) : { "CBD": 1, "PM": 1, "HHC": 0.5, "DEFAULT": 0.25 };
        if (regole[catSelezionata] !== undefined) {
            moltiplicatore = parseFloat(regole[catSelezionata]);
        }
    }

    // Calcola i punti effettivi e arrotonda a 2 decimali
    let puntiDaverificare = parseFloat((valoreInserito * moltiplicatore).toFixed(2));

    let puntiDaApplicare = azione === 'SOTTRAI' ? puntiDaverificare * -1 : puntiDaverificare;
    if (azione === 'SOTTRAI' && (clienteManualeScelto.punti + puntiDaApplicare) < 0) { mostraAvvisoModale("Il cliente non ha abbastanza punti da scaricare!"); return; }

    let saldoIniz = clienteManualeScelto.punti;

    clienteManualeScelto.punti += puntiDaApplicare;
    clienteManualeScelto.bonus = Math.floor(clienteManualeScelto.punti / 100) * 10;
    clienteManualeScelto.dataUltimaOperazione = inPuntiData.value;
    await updateCliente(clienteManualeScelto);

    // --- SINCRONIZZAZIONE FIREBASE E SALVATAGGIO MOVIMENTO ---
    let puntiCaric = azione === 'CARICA' ? puntiDaverificare : 0;
    let puntiScaric = azione === 'SOTTRAI' ? puntiDaverificare : 0;

    aggiornaFidelityFirebase(clienteManualeScelto.scheda, clienteManualeScelto.punti, inPuntiData.value);

    let d = new Date();

    // Testo formattato bene per lo scontrino
    let descMovimento = azione === 'CARICA' ? 'CARICO PUNTI MANUALE' : 'SCARICO PUNTI MANUALE';

    let recordPunti = {
        CLIENTE: clienteManualeScelto.nome,
        GIORNO: inPuntiData.value,
        ORA: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
        CONTANTI: 0,
        POS: 0,
        PUNTI_CARICATI: puntiCaric,
        PUNTI_SCARICATI: puntiScaric,
        BONUS: 0,
        SALDO_PUNTI_INIZIALE: saldoIniz,
        SALDO_PUNTI_FINALE: clienteManualeScelto.punti,
        ARTICOLI: [{
            CODICE: "PUNTI",
            ARTICOLO: "MOVIMENTO MANUALE PUNTI",
            DESCRIZIONE: descMovimento,
            TIPO: "PTS",
            IMPORTO: 0,
            QUANTITA: 1,
            CATEGORIA: "PM" // Fissato sempre a "PM"
        }]
    };
    await salvaVendita(recordPunti);

    chiudiModale('modal-punti-manuali');

    // --- PREPARAZIONE MODALE ESITO E NOTIFICHE ---
    window.datiNotificaApp = {
        scheda: clienteManualeScelto.scheda,
        saldoIniziale: saldoIniz,
        puntiAcquisiti: puntiCaric,
        puntiSpesi: puntiScaric,
        saldoFinale: clienteManualeScelto.punti,
        bonus: clienteManualeScelto.bonus
    };

    telClienteAttuale = clienteManualeScelto.telefono;

    let templateMsg = localStorage.getItem('impostazioni_msg_template') || MSG_BASE_DEFAULT;

    let strSaldoIniziale = saldoIniz.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    let strPuntiCaricati = puntiCaric.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    let strPuntiScaricati = puntiScaric.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    let strPuntiFinale = clienteManualeScelto.punti.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    let strBonus = clienteManualeScelto.bonus.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    let dataOggiTs = new Date();
    let strData = `${String(dataOggiTs.getDate()).padStart(2, '0')}/${String(dataOggiTs.getMonth() + 1).padStart(2, '0')}/${dataOggiTs.getFullYear()}`;
    let strOra = `${String(dataOggiTs.getHours()).padStart(2, '0')}:${String(dataOggiTs.getMinutes()).padStart(2, '0')}:${String(dataOggiTs.getSeconds()).padStart(2, '0')}`;

    msgDaInviarePlain = templateMsg
        .replace(/{NOME}/g, clienteManualeScelto.nome)
        .replace(/{SCHEDA}/g, clienteManualeScelto.scheda)
        .replace(/{SALDO_INIZIALE}/g, strSaldoIniziale)
        .replace(/{PUNTI_CARICATI}/g, strPuntiCaricati)
        .replace(/{PUNTI_SCARICATI}/g, strPuntiScaricati)
        .replace(/{PUNTI}/g, strPuntiFinale)
        .replace(/{BONUS}/g, strBonus)
        .replace(/{DATA}/g, strData)
        .replace(/{ORA}/g, strOra);

    let messaggioEsito = `Movimento manuale registrato con successo.<br><br>`;
    if (puntiCaric > 0) messaggioEsito += `Punti caricati: <b style="color:#00cc66;">⭐ +${strPuntiCaricati}</b><br>`;
    if (puntiScaric > 0) messaggioEsito += `Punti scaricati: <b style="color:#ff4d4d;">⭐ -${strPuntiScaricati}</b><br>`;
    messaggioEsito += `<br>Nuovo saldo punti: <b>⭐ ${strPuntiFinale}</b><br>Bonus disponibile per la prossima spesa: <b>🎁 € ${strBonus}</b>`;

    document.getElementById('msg-esito-punti').innerHTML = messaggioEsito;

    let titoloModale = document.getElementById('titolo-modal-esito');
    if (titoloModale) titoloModale.innerHTML = azione === 'CARICA' ? "✅ CARICO PUNTI EFFETTUATO" : "✅ SCARICO PUNTI EFFETTUATO";

    let btnChiudi = document.getElementById('btn-chiudi-esito');
    if (btnChiudi) btnChiudi.innerHTML = "CHIUDI";

    document.getElementById('box-notifiche').style.display = 'block';
    let btnApp = document.getElementById('btn-invia-app');
    btnApp.innerHTML = '📱 Notifica App';
    btnApp.classList.remove('inviato');

    apriModale('modal-esito');
};

// --- NUOVA FUNZIONE: INVIA SALDO DA MODALE PUNTI MANUALI ---
window.inviaSaldoPuntiManuale = function () {
    if (!clienteManualeScelto) {
        mostraAvvisoModale("Nessun cliente selezionato.");
        return;
    }

    let numero = clienteManualeScelto.telefono.replace(/[^0-9]/g, '');
    if (numero.length <= 10 && !numero.startsWith('39')) {
        numero = '39' + numero;
    }

    let d = new Date();
    let strData = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    let strOra = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

    let strPunti = clienteManualeScelto.punti.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    let strBonus = clienteManualeScelto.bonus.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    let messaggio = `*CHEMARIA FIDELITY*\n\nCiao, ${clienteManualeScelto.nome}\n\nCard N: ${clienteManualeScelto.scheda}\n\n-----------------------------------\n* Saldo Punti: ${strPunti}\n* Bonus: € ${strBonus}\n-----------------------------------\n\n${strData}\n${strOra}`;

    let url = `whatsapp://send?phone=${numero}&text=${encodeURIComponent(messaggio)}`;
    window.open(url, '_blank');
};

// 🌟 GESTIONE CLIENTI CRM E CONTROLLI
const inputCrmScheda = document.getElementById('crm-codice'); const inputCrmNome = document.getElementById('crm-nome'); const inputCrmTel = document.getElementById('crm-telefono'); const inputCrmPunti = document.getElementById('crm-punti'); const lblCrmBonus = document.getElementById('crm-calc-bonus'); const lblCrmData = document.getElementById('crm-calc-data'); const btnCrmElimina = document.getElementById('crm-btn-elimina'); const btnGeneraScheda = document.getElementById('btn-genera-scheda'); const listaCrmHTML = document.getElementById('crm-list'); const searchCrm = document.getElementById('crm-search');
let listaClientiCompleta = [];

if (btnClienti) { btnClienti.addEventListener('click', async function () { apriModale('modal-gestione-clienti'); await crmCaricaLista(); crmNuovoCliente(); searchCrm.value = ''; searchCrm.focus(); }); }

async function crmCaricaLista() { 
    listaClientiCompleta = await getAll('clienti'); 
    listaClientiCompleta.sort((a, b) => a.nome.localeCompare(b.nome)); 
    crmDisegnaLista(listaClientiCompleta); 
    
    let contatore = document.getElementById('crm-totale-clienti');
    if (contatore) contatore.textContent = `(${listaClientiCompleta.length})`;
}

function crmDisegnaLista(arrayClienti) {
    listaCrmHTML.innerHTML = '';
    arrayClienti.forEach(c => {
        let div = document.createElement('div'); div.className = 'crm-list-item';
        div.innerHTML = `<div class="crm-list-nome">${c.nome}</div><div class="crm-list-dati"><span>📞 ${c.telefono}</span> <span>⭐ ${c.punti.toLocaleString('it-IT', { maximumFractionDigits: 2 })}</span></div>`;
        div.addEventListener('click', () => { document.querySelectorAll('.crm-list-item').forEach(el => el.classList.remove('attivo')); div.classList.add('attivo'); crmCaricaScheda(c); });
        listaCrmHTML.appendChild(div);
    });
}

if (searchCrm) {
    searchCrm.addEventListener('input', function () { let t = this.value.toLowerCase().trim(); if (t === '') { crmDisegnaLista(listaClientiCompleta); return; } let filtrati = listaClientiCompleta.filter(c => c.nome.toLowerCase().includes(t) || c.telefono.includes(t) || c.scheda.includes(t)); crmDisegnaLista(filtrati); });
}

function crmCaricaScheda(c) { document.getElementById('crm-titolo-scheda').textContent = "MODIFICA CLIENTE"; inputCrmScheda.value = c.scheda; inputCrmScheda.disabled = true; btnGeneraScheda.style.display = 'none'; inputCrmNome.value = c.nome; inputCrmTel.value = c.telefono; inputCrmPunti.value = c.punti.toLocaleString('it-IT', { maximumFractionDigits: 2 }); lblCrmBonus.textContent = "€ " + c.bonus; if (c.dataUltimaOperazione) { let partiData = c.dataUltimaOperazione.split('-'); if (partiData.length === 3) { lblCrmData.textContent = `${partiData[2]}/${partiData[1]}/${partiData[0]}`; } else { lblCrmData.textContent = c.dataUltimaOperazione; } } else { lblCrmData.textContent = "-"; } btnCrmElimina.style.display = 'block'; }
window.crmNuovoCliente = function () {
    document.getElementById('crm-titolo-scheda').textContent = "NUOVO CLIENTE";
    inputCrmScheda.value = '';
    inputCrmScheda.disabled = false;
    btnGeneraScheda.style.display = 'block';
    inputCrmNome.value = '';
    inputCrmTel.value = '';
    inputCrmPunti.value = '0';
    lblCrmBonus.textContent = "€ 0";
    lblCrmData.textContent = "-";
    btnCrmElimina.style.display = 'none';
    document.querySelectorAll('.crm-list-item').forEach(el => el.classList.remove('attivo'));

    // --- NOVITÀ: Pulizia campo di ricerca e ripristino lista ---
    if (searchCrm) {
        searchCrm.value = '';
        crmDisegnaLista(listaClientiCompleta);
    }
    // -----------------------------------------------------------

    inputCrmScheda.focus();
};
window.generaCodiceSchedaUnivoco = async function () { let unico = false; let nuovoCodice = ""; btnGeneraScheda.innerHTML = "⏳..."; while (!unico) { let cifreRandom = Math.floor(Math.random() * 10000000000).toString().padStart(10, '0'); nuovoCodice = "200" + cifreRandom; let esiste = await getBySchedaOTelefono(nuovoCodice); if (!esiste) { unico = true; } } inputCrmScheda.value = nuovoCodice; btnGeneraScheda.innerHTML = "🎲 GENERA"; inputCrmTel.focus(); };
if (inputCrmPunti) {
    inputCrmPunti.addEventListener('input', function () { this.value = this.value.replace(/[^0-9.,]/g, ''); let p = parseFloat(this.value.replace(',', '.')); if (!isNaN(p)) { lblCrmBonus.textContent = "€ " + (Math.floor(p / 100) * 10); } });
}

// 1. Fase di Controllo e Apertura Modale
window.crmSalvaCliente = async function () {
    let scheda = inputCrmScheda.value.trim(); let nome = inputCrmNome.value.trim().toUpperCase(); let telefono = inputCrmTel.value.trim(); let punti = parseFloat(inputCrmPunti.value.replace(',', '.')) || 0;

    // Controlli di validità di base
    if (scheda === '' || nome === '' || telefono === '') { mostraAvvisoModale("Compila i campi obbligatori:<br>- Codice Scheda<br>- Nome Completo<br>- Numero di Telefono"); return; }

    let tuttiClienti = await getAll('clienti');
    if (!inputCrmScheda.disabled) { let checkScheda = tuttiClienti.find(c => c.scheda === scheda); if (checkScheda) { mostraAvvisoModale(`Esiste già un cliente registrato con questo Codice Scheda:<br><br><b>${checkScheda.nome}</b>`); return; } }

    let checkTelefono = tuttiClienti.find(c => c.telefono === telefono && c.scheda !== scheda);
    if (checkTelefono) { mostraAvvisoModale(`Il numero di telefono <b>${telefono}</b><br>è già associato al cliente:<br><br><b>${checkTelefono.nome}</b>`); return; }

    // Se tutto è corretto, non salviamo subito ma apriamo la conferma!
    document.getElementById('msg-conferma-salvataggio').innerHTML = `Vuoi salvare i dati per il cliente:<br><br><b style="color: #00ffcc; font-size: 2.5vh;">${nome}</b> ?`;
    apriModale('modal-conferma-salvataggio');
};

// 2. Fase di Salvataggio Effettivo (chiamata dal tasto "SÌ, SALVA" del modale)
window.eseguiSalvataggioCliente = async function () {
    // Chiudi il modale
    chiudiModale('modal-conferma-salvataggio');

    // Recupera i dati dai campi
    let scheda = inputCrmScheda.value.trim(); let nome = inputCrmNome.value.trim().toUpperCase(); let telefono = inputCrmTel.value.trim(); let punti = parseFloat(inputCrmPunti.value.replace(',', '.')) || 0;

    let bonusCalcolato = Math.floor(punti / 100) * 10; let dataOp;
    if (lblCrmData.textContent === "-") { dataOp = getOggiString(); } else { let parti = lblCrmData.textContent.split('/'); if (parti.length === 3) { dataOp = `${parti[2]}-${parti[1]}-${parti[0]}`; } else { dataOp = getOggiString(); } }

    let nuovoCliente = { scheda: scheda, nome: nome, telefono: telefono, punti: punti, bonus: bonusCalcolato, dataUltimaOperazione: dataOp };

    // Salva nel database
    await updateCliente(nuovoCliente);

    // Aggiornamento Visivo e feedback di successo
    document.getElementById('crm-titolo-scheda').textContent = "✅ SALVATO!";
    document.getElementById('crm-titolo-scheda').style.color = "#00ff00";
    setTimeout(() => { document.getElementById('crm-titolo-scheda').textContent = "MODIFICA CLIENTE"; document.getElementById('crm-titolo-scheda').style.color = "white"; }, 1500);

    await crmCaricaLista();
    inputCrmScheda.disabled = true;
    btnGeneraScheda.style.display = 'none';
    btnCrmElimina.style.display = 'block';
};

// ============================================
// 🗑️ SISTEMA UNIVERSALE ELIMINAZIONE / STORNO
// ============================================
let idDaEliminare = "";
let tipoEliminazione = ""; // 'CLIENTE', 'PRODOTTO', o 'SCONTRINO'

window.confermaEliminazioneCliente = function () {
    idDaEliminare = document.getElementById('crm-codice').value.trim();
    tipoEliminazione = 'CLIENTE';
    if (idDaEliminare === '') return;
    document.getElementById('msg-conferma-elimina').innerHTML = "Sei sicuro di voler ELIMINARE DEFINITIVAMENTE questo cliente?";
    apriModale('modal-conferma-elimina');
};

window.confermaEliminazioneMagazzino = function () {
    idDaEliminare = document.getElementById('mag-codice').value.trim();
    tipoEliminazione = 'PRODOTTO';
    if (idDaEliminare === '') return;
    document.getElementById('msg-conferma-elimina').innerHTML = "Sei sicuro di voler ELIMINARE DEFINITIVAMENTE questo articolo dal magazzino?";
    apriModale('modal-conferma-elimina');
};

window.confermaAnnullamentoScontrino = function (idScontrino) {
    idDaEliminare = idScontrino;
    tipoEliminazione = 'SCONTRINO';
    document.getElementById('msg-conferma-elimina').innerHTML = "Sei sicuro di voler <b>ANNULLARE</b> questo scontrino?<br><br><span style='color:#b3d9ff;'>I prodotti verranno reinseriti in magazzino e i punti stornati dalla scheda del cliente.</span>";
    apriModale('modal-conferma-elimina');
};

window.confermaAnnullamentoMovimento = function (idMovimento, tipo) {
    idDaEliminare = idMovimento;
    tipoEliminazione = 'MOVIMENTO';
    let nomeOperazione = tipo === 'ENTRATA' ? 'questo INCASSO EXTRA' : 'questa SPESA';
    document.getElementById('msg-conferma-elimina').innerHTML = `Sei sicuro di voler <b>ELIMINARE</b> ${nomeOperazione} dal registro di cassa?`;
    apriModale('modal-conferma-elimina');
};

// Motore di scarico giacenze con gestione Ricorsiva Kit Dinamici
function scaricaGiacenzeMagazzino(articoliCarrello) {
    return new Promise(async (resolve) => {
        let txMag = db.transaction('magazzino', 'readwrite');
        let storeMag = txMag.objectStore('magazzino');

        for (let art of articoliCarrello) {
            if (art.codice === 'PUNTI' || art.codice.startsWith('MAN-') || art.codice.startsWith('REP-')) continue;

            let req = storeMag.get(art.codice);
            req.onsuccess = function () {
                let prodotto = req.result;
                if (prodotto) {
                    // Esplosione Kit Dinamico
                    if (prodotto.is_kit && prodotto.tipo_kit === 'DINAMICO' && prodotto.componenti_kit) {
                        prodotto.componenti_kit.forEach(comp => {
                            let reqComp = storeMag.get(comp.codice);
                            reqComp.onsuccess = function () {
                                if (reqComp.result) {
                                    reqComp.result.giacenza -= (comp.qta * art.qta);
                                    storeMag.put(reqComp.result);
                                }
                            }
                        });
                    } else {
                        // Scarico standard o Kit Statico
                        prodotto.giacenza -= art.qta;
                        storeMag.put(prodotto);
                    }
                }
            };
        }
        txMag.oncomplete = () => resolve();
    });
}

// Funzione isolata per gestire il ricarico nel database IndexedDB
function ripristinaGiacenzeMagazzino(articoli) {
    return new Promise((resolve) => {
        let txMag = db.transaction('magazzino', 'readwrite');
        let storeMag = txMag.objectStore('magazzino');
        articoli.forEach(art => {
            if (art.CODICE !== 'PUNTI' && !art.CODICE.startsWith('MAN-') && !art.CODICE.startsWith('REP-')) {
                let req = storeMag.get(art.CODICE);
                req.onsuccess = function () {
                    if (req.result) {
                        let prodotto = req.result;
                        // Rollback Kit Dinamico
                        if (prodotto.is_kit && prodotto.tipo_kit === 'DINAMICO' && prodotto.componenti_kit) {
                            prodotto.componenti_kit.forEach(comp => {
                                let reqComp = storeMag.get(comp.codice);
                                reqComp.onsuccess = function () {
                                    if (reqComp.result) {
                                        reqComp.result.giacenza += (comp.qta * art.QUANTITA);
                                        storeMag.put(reqComp.result);
                                    }
                                }
                            });
                        } else {
                            prodotto.giacenza += art.QUANTITA;
                            storeMag.put(prodotto);
                        }
                    }
                }
            }
        });
        txMag.oncomplete = () => resolve();
    });
}

window.eseguiEliminazioneUniversale = async function () {
    chiudiModale('modal-conferma-elimina');

    if (tipoEliminazione === 'CLIENTE') {
        await deleteRecord('clienti', idDaEliminare);

        // 🔥 CLOUD-SYNC: Elimina definitivamente anche dal Cloud
        if (navigator.onLine) fetch(`${FIREBASE_URL}/clienti/${idDaEliminare}.json`, { method: 'DELETE' }).catch(e => console.log(e));

        crmNuovoCliente();
        await crmCaricaLista();
        mostraMessaggio("CLIENTE ELIMINATO");

    } else if (tipoEliminazione === 'PRODOTTO') {
        await deleteRecord('magazzino', idDaEliminare);

        // 🔥 CLOUD-SYNC: Elimina definitivamente anche dal Cloud
        if (navigator.onLine) fetch(`${FIREBASE_URL}/magazzino/${idDaEliminare}.json`, { method: 'DELETE' }).catch(e => console.log(e));

        magNuovoProdotto();
        await magCaricaLista();
        mostraMessaggio("PRODOTTO ELIMINATO");

    } else if (tipoEliminazione === 'SCONTRINO') {
        let scontrino = await getRecordById('vendite', idDaEliminare);

        if (scontrino) {
            // 1. Rollback Magazzino
            if (scontrino.ARTICOLI && scontrino.ARTICOLI.length > 0) {
                await ripristinaGiacenzeMagazzino(scontrino.ARTICOLI);
            }

            // 2. Rollback Cliente
            if (scontrino.CLIENTE !== "Nessuno") {
                let tuttiClienti = await getAll('clienti');
                // Cerca il cliente tramite il nome esatto salvato nello scontrino
                let cliente = tuttiClienti.find(c => c.nome === scontrino.CLIENTE);

                if (cliente) {
                    cliente.punti -= (scontrino.PUNTI_CARICATI || 0);
                    cliente.punti += (scontrino.PUNTI_SCARICATI || 0); // Restituisce i punti spesi per il bonus!
                    cliente.bonus = Math.floor(cliente.punti / 100) * 10;
                    await updateCliente(cliente);

                    // Aggiorna in tempo reale anche Firebase
                    aggiornaFidelityFirebase(cliente.scheda, cliente.punti, getOggiString());
                }
            }

            // 3. Eliminazione scontrino e aggiornamento visivo
            await deleteRecord('vendite', idDaEliminare);

            // 🔥 RIMUOVE L'INCASSO DAL CRUSCOTTO DIREZIONALE E DAL BACKUP PERMANENTE
            eliminaVenditaLive(scontrino.GIORNO, idDaEliminare);
            if (navigator.onLine) fetch(`${FIREBASE_URL}/storico_vendite/${idDaEliminare}.json`, { method: 'DELETE' }).catch(e => console.log(e));

            await popolaRegistroCassa(); // Ricarica il registro di cassa pulito
            mostraMessaggio("SCONTRINO ANNULLATO CON SUCCESSO");
        }
    } else if (tipoEliminazione === 'MOVIMENTO') {
        await deleteRecord('movimenti_cassa', idDaEliminare);
        await popolaRegistroCassa(); // Ricarica il registro aggiornando i totali
        mostraMessaggio("MOVIMENTO ELIMINATO CON SUCCESSO");
    }
};

// 🌟 REGISTRO CASSA E MOVIMENTI
if (btnRegistro) { btnRegistro.addEventListener('click', async function () { await popolaRegistroCassa(); apriModale('modal-registro-cassa'); }); }

async function popolaRegistroCassa() {
    let dataDiOggiStr = getOggiString();
    let venditeOggi = await getByDate('vendite', 'giorno', dataDiOggiStr);
    let movimentiOggi = await getByDate('movimenti_cassa', 'data', dataDiOggiStr);

    let totPOS = 0; let totContantiVendite = 0; let totEntrateExtra = 0; let totUscite = 0;
    let numeroScontrini = venditeOggi.length; let listaHtml = "";

    // 1. Uniamo tutte le operazioni in un unico Array
    let operazioniMiste = [];

    venditeOggi.forEach(v => {
        totPOS += v.POS;
        totContantiVendite += v.CONTANTI;
        operazioniMiste.push({ ...v, isVendita: true, sortTime: v.ORA });
    });

    movimentiOggi.forEach(m => {
        if (m.tipo === 'ENTRATA') totEntrateExtra += m.importo;
        if (m.tipo === 'USCITA') totUscite += m.importo;
        operazioniMiste.push({ ...m, isVendita: false, sortTime: m.ora });
    });

    // 2. Mettiamo tutto in ordine cronologico (dal più vecchio al più recente)
    operazioniMiste.sort((a, b) => a.sortTime.localeCompare(b.sortTime));

    // 3. Disegniamo la lista riga per riga già ordinata
    operazioniMiste.forEach(item => {
        if (item.isVendita) {
            let v = item;
            let totScontrino = v.POS + v.CONTANTI;

            let intestazioneScontrino = "Scontrino";
            if (v.ARTICOLI && v.ARTICOLI.length > 0 && v.ARTICOLI[0].CODICE === "PUNTI") {
                intestazioneScontrino = "Scontrino ricarica punti";
            }

            listaHtml += `
                <div class="reg-item vendita" style="align-items: center;">
                    <div class="reg-item-ora">${v.ORA}</div>
                    <div class="reg-item-desc">${intestazioneScontrino} ${v.CLIENTE !== "Nessuno" ? " - " + v.CLIENTE : ""}</div>
                    <div class="reg-item-val" style="color:#4d88ff; margin-right: 15px;">+ € ${totScontrino.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                    <div style="display: flex; gap: 8px;">
                        <button onclick="visualizzaScontrinoDaRegistro(${v.id})" style="background: rgba(77,136,255,0.2); border: 1px solid #4d88ff; color: #b3d9ff; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 1.6vh;" title="Vedi Dettaglio">👁️</button>
                        <button onclick="confermaAnnullamentoScontrino(${v.id})" style="background: rgba(255,77,77,0.2); border: 1px solid #ff4d4d; color: #ff4d4d; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 1.6vh;" title="Annulla Scontrino">❌</button>
                    </div>
                </div>`;
        } else {
            let m = item;
            if (m.tipo === 'ENTRATA') {
                listaHtml += `
                    <div class="reg-item entrata" style="align-items: center;">
                        <div class="reg-item-ora">${m.ora}</div>
                        <div class="reg-item-desc">${m.descrizione}</div>
                        <div class="reg-item-val verde" style="margin-right: 15px;">+ € ${m.importo.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                        <button onclick="confermaAnnullamentoMovimento(${m.id}, 'ENTRATA')" style="background: rgba(255,77,77,0.2); border: 1px solid #ff4d4d; color: #ff4d4d; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 1.6vh;" title="Elimina Entrata">❌</button>
                    </div>`;
            } else if (m.tipo === 'USCITA') {
                listaHtml += `
                    <div class="reg-item uscita" style="align-items: center;">
                        <div class="reg-item-ora">${m.ora}</div>
                        <div class="reg-item-desc">${m.descrizione}</div>
                        <div class="reg-item-val rosso" style="margin-right: 15px;">- € ${m.importo.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                        <button onclick="confermaAnnullamentoMovimento(${m.id}, 'USCITA')" style="background: rgba(255,77,77,0.2); border: 1px solid #ff4d4d; color: #ff4d4d; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 1.6vh;" title="Elimina Spesa">❌</button>
                    </div>`;
            }
        }
    });

    // 🔥 NUOVI CALCOLI DISTINTI
    let saldoTotaleGiornata = totPOS + totContantiVendite + totEntrateExtra - totUscite; // Tutto incluso
    let saldoCassetto = totContantiVendite + totEntrateExtra - totUscite; // Solo contanti fisici

    // Aggiornamento interfaccia
    document.getElementById('reg-num-scontrini').textContent = numeroScontrini;
    document.getElementById('reg-tot-pos').textContent = "€ " + totPOS.toLocaleString('it-IT', { minimumFractionDigits: 2 });
    document.getElementById('reg-tot-contanti').textContent = "€ " + totContantiVendite.toLocaleString('it-IT', { minimumFractionDigits: 2 });
    document.getElementById('reg-tot-entrate').textContent = "€ " + totEntrateExtra.toLocaleString('it-IT', { minimumFractionDigits: 2 });
    document.getElementById('reg-tot-uscite').textContent = "€ " + totUscite.toLocaleString('it-IT', { minimumFractionDigits: 2 });

    // Assegna il nuovo Saldo Totale (se l'elemento esiste nell'HTML)
    let elemSaldoTotale = document.getElementById('reg-saldo-totale');
    if (elemSaldoTotale) elemSaldoTotale.textContent = "€ " + saldoTotaleGiornata.toLocaleString('it-IT', { minimumFractionDigits: 2 });

    document.getElementById('reg-saldo-cassetto').textContent = "€ " + saldoCassetto.toLocaleString('it-IT', { minimumFractionDigits: 2 });

    if (listaHtml === "") listaHtml = "<div style='text-align:center; padding:20px; color:#8888bb;'>Nessun movimento registrato oggi.</div>";
    document.getElementById('reg-lista-movimenti').innerHTML = listaHtml;
}

if (btnDipendente) {
    btnDipendente.addEventListener('click', () => { document.getElementById('spesa-data').value = getOggiString(); document.getElementById('spesa-importo').value = ''; document.getElementById('spesa-descrizione').value = ''; apriModale('modal-spesa'); setTimeout(() => document.getElementById('spesa-importo').focus(), 100); });
}

if (btnMacchinetta) {
    btnMacchinetta.addEventListener('click', () => { document.getElementById('distributore-data').value = getOggiString(); document.getElementById('distributore-importo').value = ''; apriModale('modal-distributore'); setTimeout(() => document.getElementById('distributore-importo').focus(), 100); });
}

const spesaImp = document.getElementById('spesa-importo'); if (spesaImp) { spesaImp.addEventListener('input', function () { this.value = this.value.replace(/[^0-9.,]/g, ''); }); }
const distImp = document.getElementById('distributore-importo'); if (distImp) { distImp.addEventListener('input', function () { this.value = this.value.replace(/[^0-9.,]/g, ''); }); }

window.salvaSpesa = async function () {
    let impString = document.getElementById('spesa-importo').value.trim().replace(',', '.'); let importo = parseFloat(impString); let desc = document.getElementById('spesa-descrizione').value.trim() || "Uscita generica"; let dataSelezionata = document.getElementById('spesa-data').value;
    if (isNaN(importo) || importo <= 0) { mostraAvvisoModale("Inserisci un importo valido!"); return; } if (!dataSelezionata) { mostraAvvisoModale("Seleziona una data valida!"); return; }
    let d = new Date(); let hh = String(d.getHours()).padStart(2, '0'); let min = String(d.getMinutes()).padStart(2, '0');
    let nuovoMovimento = { data: dataSelezionata, ora: `${hh}:${min}`, tipo: "USCITA", importo: importo, descrizione: desc };

    // Salva nel PC e recupera l'ID
    nuovoMovimento.id = await salvaMovimentoCassaDB(nuovoMovimento);

    // 🔥 INVIA AL CRUSCOTTO FIREBASE
    if (typeof inviaMovimentoLive === "function") inviaMovimentoLive(nuovoMovimento);

    chiudiModale('modal-spesa'); mostraMessaggio("SPESA REGISTRATA CON SUCCESSO");
};

window.salvaDistributore = async function () {
    let impString = document.getElementById('distributore-importo').value.trim().replace(',', '.'); let importo = parseFloat(impString); let dataSelezionata = document.getElementById('distributore-data').value;
    if (isNaN(importo) || importo <= 0) { mostraAvvisoModale("Inserisci un importo valido!"); return; } if (!dataSelezionata) { mostraAvvisoModale("Seleziona una data valida!"); return; }
    let d = new Date(); let hh = String(d.getHours()).padStart(2, '0'); let min = String(d.getMinutes()).padStart(2, '0');
    let nuovoMovimento = { data: dataSelezionata, ora: `${hh}:${min}`, tipo: "ENTRATA", importo: importo, descrizione: "Incasso Distributore" };

    // Salva nel PC e recupera l'ID
    nuovoMovimento.id = await salvaMovimentoCassaDB(nuovoMovimento);

    // 🔥 INVIA AL CRUSCOTTO FIREBASE
    if (typeof inviaMovimentoLive === "function") inviaMovimentoLive(nuovoMovimento);

    chiudiModale('modal-distributore'); mostraMessaggio("INCASSO DISTRIBUTORE REGISTRATO");
};

// ==========================================
// 🌟 LOGICA STORICO CALENDARIO (GIORNALE)
// ==========================================
const btnCalendario = document.getElementById('btn-calendario');
let dataCalendarioVisualizzato = new Date(); // Memoria del mese attualmente a schermo

if (btnCalendario) {
    btnCalendario.addEventListener('click', async function () {
        dataCalendarioVisualizzato = new Date(); // Reset: parte sempre dal mese corrente
        await popolaStoricoCalendario();
        apriModale('modal-calendario');
    });
}

// Funzione agganciata ai pulsanti "Precedente" e "Successivo"
window.cambiaMeseCalendario = async function (delta) {
    dataCalendarioVisualizzato.setMonth(dataCalendarioVisualizzato.getMonth() + delta);
    await popolaStoricoCalendario();
};

async function popolaStoricoCalendario() {
    let tutteVendite = await getAll('vendite');
    let tuttiMovimenti = await getAll('movimenti_cassa');

    let anno = dataCalendarioVisualizzato.getFullYear();
    let mese = dataCalendarioVisualizzato.getMonth() + 1; // Mese che stiamo visualizzando (1-12)

    let oggiReale = new Date();
    // Capisce se stiamo guardando il mese di adesso o un mese passato
    let isMeseCorrente = (anno === oggiReale.getFullYear() && mese === oggiReale.getMonth() + 1);

    // Trova quanti giorni ha il mese in totale (es. 28, 30, 31)
    let giorniNelMese = new Date(anno, mese, 0).getDate();

    // Se è il mese corrente, si ferma a oggi. Se è un mese passato, mostra tutti i giorni!
    let giornoLimite = isMeseCorrente ? oggiReale.getDate() : giorniNelMese;

    let strMese = String(mese).padStart(2, '0');
    let strAnno = String(anno);

    // Nomi dei mesi per il titolo
    const nomiMesi = ["Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno", "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"];
    document.getElementById('titolo-mese-calendario').textContent = `📅 GIORNALE - ${nomiMesi[dataCalendarioVisualizzato.getMonth()].toUpperCase()} ${anno}`;

    // 1. Inizializza l'oggetto con i giorni da 1 a giornoLimite (tutti a zero)
    let giornateMensili = {};
    for (let i = 1; i <= giornoLimite; i++) {
        let strGiorno = String(i).padStart(2, '0');
        let dataKey = `${strAnno}-${strMese}-${strGiorno}`;
        giornateMensili[dataKey] = { contanti: 0, pos: 0, distr: 0, uscite: 0, netto: 0 };
    }

    // 2. Somma le vendite del mese scelto
    tutteVendite.forEach(v => {
        if (v.GIORNO && v.GIORNO.startsWith(`${strAnno}-${strMese}`)) {
            if (giornateMensili[v.GIORNO]) {
                giornateMensili[v.GIORNO].contanti += v.CONTANTI;
                giornateMensili[v.GIORNO].pos += v.POS;
            }
        }
    });

    // 3. Somma i movimenti (Spese e Distributore) del mese scelto
    tuttiMovimenti.forEach(m => {
        if (m.data && m.data.startsWith(`${strAnno}-${strMese}`)) {
            if (giornateMensili[m.data]) {
                if (m.tipo === 'ENTRATA') giornateMensili[m.data].distr += m.importo;
                if (m.tipo === 'USCITA') giornateMensili[m.data].uscite += m.importo;
            }
        }
    });

    // 4. Costruisci la tabella HTML e calcola i totali
    let htmlLista = "";
    let totContanti = 0, totPos = 0, totDistr = 0, totUscite = 0, totNettoMese = 0;
    let recordIncasso = 0;
    let dataRecord = "-";

    // Creiamo la lista
    for (let i = 1; i <= giornoLimite; i++) {
        let strGiorno = String(i).padStart(2, '0');
        let dataKey = `${strAnno}-${strMese}-${strGiorno}`;
        let g = giornateMensili[dataKey];

        g.netto = g.contanti + g.pos + g.distr - g.uscite;

        // Aggiorna accumulatori
        totContanti += g.contanti;
        totPos += g.pos;
        totDistr += g.distr;
        totUscite += g.uscite;
        totNettoMese += g.netto;

        // Controlla record
        if (g.netto > recordIncasso) {
            recordIncasso = g.netto;
            dataRecord = `${strGiorno}/${strMese}/${strAnno}`;
        }

        htmlLista += `
                        <div class="riga-prodotto" style="grid-template-columns: 1.5fr 1fr 1fr 1fr 1fr 1.2fr; font-size: 1.9vh; padding: 10px 5px; border-bottom: 1px solid rgba(255,255,255,0.1); cursor: default; color: #fff; transition: background 0.2s;" onmouseover="this.style.backgroundColor='rgba(255,255,255,0.1)'" onmouseout="this.style.backgroundColor='transparent'">
                            <div class="col-sinistra" style="color: #b3d9ff;">${strGiorno}/${strMese}/${strAnno}</div>
                            <div class="col-valuta" style="color: #ffffff;">€ ${g.contanti.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                            <div class="col-valuta" style="color: #ffffff;">€ ${g.pos.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                            <div class="col-valuta" style="color: #ffffff;">€ ${g.distr.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                            <div class="col-valuta" style="color: #ff4d4d;">- € ${g.uscite.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                            <div class="col-valuta" style="color: #00ffcc; font-weight: bold;">€ ${g.netto.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                        </div>
                    `;
    }

    // HTML riga Totali Fissi in basso
    let htmlTotali = `
                        <div class="col-sinistra" style="color:#00ffcc;">TOTALI</div>
                        <div class="col-valuta" style="color:#ffcc00;">€ ${totContanti.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                        <div class="col-valuta" style="color:#ffcc00;">€ ${totPos.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                        <div class="col-valuta" style="color:#ffcc00;">€ ${totDistr.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                        <div class="col-valuta" style="color:#ff4d4d;">- € ${totUscite.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                        <div class="col-valuta" style="color:#00ffcc; font-size: 2.2vh;">€ ${totNettoMese.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                    `;

    // Formule Medie e Proiezioni Intelligenti
    let mediaGiornaliera = giornoLimite > 0 ? (totNettoMese / giornoLimite) : 0;

    // Se guardo un mese passato la proiezione non serve (è il totale), se guardo il corrente calcola la stima a fine mese
    let proiezioneMensile = isMeseCorrente ? (mediaGiornaliera * giorniNelMese) : totNettoMese;

    // Aggiorna l'interfaccia
    document.getElementById('calendario-lista').innerHTML = htmlLista;
    document.getElementById('calendario-totali-colonne').innerHTML = htmlTotali;

    document.getElementById('cal-tot-mese').textContent = '€ ' + totNettoMese.toLocaleString('it-IT', { minimumFractionDigits: 2 });
    document.getElementById('cal-media').textContent = '€ ' + mediaGiornaliera.toLocaleString('it-IT', { minimumFractionDigits: 2 });
    document.getElementById('cal-proiezione').textContent = '€ ' + proiezioneMensile.toLocaleString('it-IT', { minimumFractionDigits: 2 });
    document.getElementById('cal-best-val').textContent = '€ ' + recordIncasso.toLocaleString('it-IT', { minimumFractionDigits: 2 });
    document.getElementById('cal-best-date').textContent = dataRecord;
}

// ==========================================
// 🌟 LOGICA CONTABILITÀ E RICERCA AVANZATA
// ==========================================
const btnContabilita = document.getElementById('btn-contabilita');
const contMese = document.getElementById('cont-mese');
const contFiltroTipo = document.getElementById('cont-filtro-tipo');
const contCercaProd = document.getElementById('cont-cerca-prod');
const contCercaNome = document.getElementById('cont-cerca-nome');
const contCercaTel = document.getElementById('cont-cerca-tel');
const contListaRisultati = document.getElementById('cont-lista-risultati');

// Cache globale per la contabilità
let storicoCompletoContabilita = [];

if (btnContabilita) {
    btnContabilita.addEventListener('click', async function () {
        // Imposta il mese corrente di default
        let oggi = new Date();
        contMese.value = `${oggi.getFullYear()}-${String(oggi.getMonth() + 1).padStart(2, '0')}`;

        // Resetta gli altri campi
        contFiltroTipo.value = "TUTTI";
        contCercaProd.value = "";
        contCercaNome.value = "";
        contCercaTel.value = "";

        apriModale('modal-contabilita');
        await caricaDatiContabilita();
    });
}

// Funzione per scaricare TUTTO dal DB e creare un array unificato
async function caricaDatiContabilita() {
    let vendite = await getAll('vendite');
    let movimenti = await getAll('movimenti_cassa');

    storicoCompletoContabilita = [];

    // Aggiungiamo le vendite formattandole
    vendite.forEach(v => {
        storicoCompletoContabilita.push({
            sorgente: 'vendita',
            data: v.GIORNO,
            ora: v.ORA,
            cliente: v.CLIENTE,
            totale: v.CONTANTI + v.POS, // Totale pagato
            pagamento: v.POS > 0 ? "POS" : "CONTANTI",
            bonus: v.BONUS,
            puntiCaricati: v.PUNTI_CARICATI,
            articoli: v.ARTICOLI || [], // array del carrello
            raw: v // l'oggetto intero originale
        });
    });

    // Aggiungiamo i movimenti
    movimenti.forEach(m => {
        storicoCompletoContabilita.push({
            sorgente: 'movimento',
            data: m.data,
            ora: m.ora,
            tipoMov: m.tipo, // ENTRATA o USCITA
            descrizione: m.descrizione,
            totale: m.importo,
            raw: m
        });
    });

    // Ordiniamo tutto dal più recente al più vecchio (Data + Ora)
    storicoCompletoContabilita.sort((a, b) => {
        let dateTimeA = new Date(a.data + "T" + a.ora);
        let dateTimeB = new Date(b.data + "T" + b.ora);
        return dateTimeB - dateTimeA;
    });

    eseguiFiltriContabilita();
}

// Applica i filtri Live
function eseguiFiltriContabilita() {
    let filtroMese = contMese.value; // formato YYYY-MM
    let filtroTipo = contFiltroTipo.value;
    let txtProd = contCercaProd.value.toLowerCase().trim();
    let txtNome = contCercaNome.value.toLowerCase().trim();
    let txtTel = contCercaTel.value.toLowerCase().trim();

    let risultati = storicoCompletoContabilita.filter(item => {
        // 1. Filtro Mese
        if (filtroMese && !item.data.startsWith(filtroMese)) return false;

        // 2. Filtro Tipo (Dropdown)
        if (filtroTipo === "MULTIPLE" && (item.sorgente !== 'vendita' || item.articoli.length <= 1)) return false;
        if (filtroTipo === "BONUS" && (item.sorgente !== 'vendita' || item.bonus <= 0)) return false;
        if (filtroTipo === "USCITA" && (item.sorgente !== 'movimento' || item.tipoMov !== 'USCITA')) return false;
        if (filtroTipo === "ENTRATA" && (item.sorgente !== 'movimento' || item.tipoMov !== 'ENTRATA')) return false;

        // 3. Ricerca Nome Cliente
        if (txtNome !== "") {
            if (item.sorgente !== 'vendita') return false; // i movimenti non hanno nome
            if (!item.cliente.toLowerCase().includes(txtNome)) return false;
        }

        // 4. Ricerca Telefono/Scheda
        if (txtTel !== "") {
            if (item.sorgente !== 'vendita') return false;
            // Siccome nel db vendite salviamo solo il nome, se vogliamo cercare per telefono
            // dobbiamo averlo salvato o fare una query complessa. Nel nostro codice attuale
            // non salviamo il tel nella ricevuta. Cerca nella stringa cliente per sicurezza.
            if (!item.raw.CLIENTE.includes(txtTel)) return false;
        }

        // 5. Ricerca Prodotto
        if (txtProd !== "") {
            if (item.sorgente !== 'vendita') return false;
            let trovato = item.articoli.some(art => art.DESCRIZIONE.toLowerCase().includes(txtProd));
            if (!trovato) return false;
        }

        return true;
    });

    disegnaTabellaContabilita(risultati);
}

// Event Listeners per rendere la ricerca LIVE
contMese.addEventListener('change', eseguiFiltriContabilita);
contFiltroTipo.addEventListener('change', eseguiFiltriContabilita);
contCercaProd.addEventListener('input', eseguiFiltriContabilita);
contCercaNome.addEventListener('input', eseguiFiltriContabilita);
contCercaTel.addEventListener('input', eseguiFiltriContabilita);

function disegnaTabellaContabilita(arrayDati) {
    contListaRisultati.innerHTML = '';

    if (arrayDati.length === 0) {
        contListaRisultati.innerHTML = '<div style="text-align:center; padding: 30px; color: #8888bb; font-size: 2vh;">Nessun risultato trovato con questi filtri.</div>';
        return;
    }

    arrayDati.sort((a, b) => {
        let dataOraA = a.data + "T" + (a.ora || "00:00");
        let dataOraB = b.data + "T" + (b.ora || "00:00");
        if (dataOraA < dataOraB) return -1;
        if (dataOraA > dataOraB) return 1;
        return 0;
    });

    const gridStyle = '1.5fr 0.8fr 0.8fr 2fr 1fr 1fr 0.6fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr';

    arrayDati.forEach((item) => {
        let dataParti = item.data.split('-');
        let giornoIT = `${dataParti[2]}/${dataParti[1]}/${dataParti[0]}`;

        if (item.sorgente === 'vendita') {
            let bonusUsato = item.bonus || 0;

            if (item.articoli && item.articoli.length > 0) {
                // Stampiamo UNA SOLA RIGA per l'intero scontrino
                let div = document.createElement('div');
                div.style.display = 'grid';
                div.style.gridTemplateColumns = gridStyle;
                div.style.padding = '10px 5px';
                div.style.borderBottom = '1px solid rgba(255,255,255,0.1)';
                div.style.fontSize = '1.5vh';
                div.style.alignItems = 'center';
                div.style.color = '#ffffff';
                div.style.transition = 'background-color 0.1s';
                div.style.cursor = 'pointer';

                div.onmouseover = function () { this.style.backgroundColor = 'rgba(255,255,255,0.2)'; }
                div.onmouseout = function () { this.style.backgroundColor = 'transparent'; }

                let strContanti = `€ ${item.raw.CONTANTI.toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;
                let strPos = `€ ${item.raw.POS.toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;
                let strBonus = bonusUsato > 0 ? `-€ ${bonusUsato.toLocaleString('it-IT', { minimumFractionDigits: 2 })}` : "€ 0,00";

                let strSIniz = item.raw.SALDO_PUNTI_INIZIALE !== undefined ? item.raw.SALDO_PUNTI_INIZIALE : "-";
                let strPCaric = `+${item.raw.PUNTI_CARICATI}`;
                let strPScaric = `-${item.raw.PUNTI_SCARICATI}`;
                let strSFin = item.raw.SALDO_PUNTI_FINALE !== undefined ? item.raw.SALDO_PUNTI_FINALE : "-";

                let strCliente = item.cliente;

                // Se è un solo articolo mostra il nome, altrimenti mostra VENDITA MULTIPLA per far quadrare i totali
                let desc = "";
                let cat = "";
                let importoMerce = 0;
                let quantitaTotale = 0;

                if (item.articoli.length === 1) {
                    desc = item.articoli[0].DESCRIZIONE;
                    cat = item.articoli[0].CATEGORIA || '-';
                    importoMerce = item.articoli[0].IMPORTO;
                    quantitaTotale = item.articoli[0].QUANTITA;
                } else {
                    desc = `VENDITA MULTIPLA (${item.articoli.length} ART.)`;
                    cat = "MULTIPLA";
                    item.articoli.forEach(a => {
                        importoMerce += a.IMPORTO;
                        quantitaTotale += a.QUANTITA;
                    });
                }

                desc += ` <span style="font-size: 1.2vh; background: #4d88ff; padding: 2px 4px; border-radius: 3px; color: white; margin-left: 5px;" title="Vedi Dettaglio">👁️</span>`;

                div.innerHTML = `
                            <div style="text-align: left !important; color: #b3d9ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${strCliente}">${strCliente}</div>
                            <div style="text-align: center !important;">${giornoIT}</div>
                            <div style="text-align: center !important;">${item.ora}</div>
                            <div style="text-align: left !important; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="Clicca per i dettagli">${desc}</div>
                            <div style="text-align: center !important;">${cat}</div>
                            <div style="text-align: center !important; color: #00ffcc;">€ ${importoMerce.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                            <div style="text-align: center !important;">${quantitaTotale}</div>
                            
                            <div style="text-align: center !important; color: #ffcc00;">${strContanti}</div>
                            <div style="text-align: center !important; color: #ffcc00;">${strPos}</div>
                            
                            <div style="text-align: center !important;">${strSIniz}</div>
                            <div style="text-align: center !important; color: #00cc66;">${strPCaric}</div>
                            <div style="text-align: center !important; color: #ff4d4d;">${strPScaric}</div>
                            <div style="text-align: center !important; color: #ff6666;">${strBonus}</div>
                            <div style="text-align: center !important; font-weight: bold;">${strSFin}</div>
                        `;

                div.addEventListener('click', () => apriDettaglioScontrino(item.raw));
                contListaRisultati.appendChild(div);
            }
        } else {
            let div = document.createElement('div');
            div.style.display = 'grid';
            div.style.gridTemplateColumns = gridStyle;
            div.style.padding = '10px 5px';
            div.style.borderBottom = '1px solid rgba(255,255,255,0.1)';
            div.style.fontSize = '1.5vh';
            div.style.alignItems = 'center';
            div.style.color = '#ffffff';

            let coloreTipo = item.tipoMov === 'ENTRATA' ? '#00cc66' : '#ff4d4d';
            let segno = item.tipoMov === 'ENTRATA' ? '+' : '-';

            div.innerHTML = `
                        <div style="text-align: center !important; color: #666;">-</div>
                        <div style="text-align: center !important;">${giornoIT}</div>
                        <div style="text-align: center !important;">${item.ora}</div>
                        <div style="text-align: left !important; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${item.descrizione}</div>
                        <div style="text-align: center !important; color: ${coloreTipo}; font-weight: bold;">${item.tipoMov}</div>
                        <div style="text-align: center !important; color: ${coloreTipo};">€ ${item.totale.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                        <div style="text-align: center !important;">-</div>
                        
                        <div style="text-align: center !important; color: ${coloreTipo};">${item.tipoMov === 'ENTRATA' ? segno : ''}€ ${item.totale.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                        <div style="text-align: center !important;">-</div>
                        
                        <div style="text-align: center !important;">-</div>
                        <div style="text-align: center !important;">-</div>
                        <div style="text-align: center !important;">-</div>
                        <div style="text-align: center !important;">-</div>
                        <div style="text-align: center !important;">-</div>
                    `;
            contListaRisultati.appendChild(div);
        }
    });
}

// 🌟 APERTURA DETTAGLIO SCONTRINO (Lettura array ARTICOLI)
// Funzione ponte per aprire il dettaglio direttamente dal Registro Giornaliero
window.visualizzaScontrinoDaRegistro = async function (idScontrino) {
    let scontrino = await getRecordById('vendite', idScontrino);
    if (scontrino) {
        apriDettaglioScontrino(scontrino);
    }
};
window.apriDettaglioScontrino = function (venditaRaw) {
    let dataIT = venditaRaw.GIORNO.split('-').reverse().join('/');
    document.getElementById('det-dataora').textContent = `${dataIT} - Ore ${venditaRaw.ORA}`;
    document.getElementById('det-cliente').textContent = venditaRaw.CLIENTE !== "Nessuno" ? "Cliente: " + venditaRaw.CLIENTE : "Scontrino Libero";

    let listaHTML = "";
    let totaleMerce = 0;

    if (venditaRaw.ARTICOLI && venditaRaw.ARTICOLI.length > 0) {
        venditaRaw.ARTICOLI.forEach(art => {
            listaHTML += `
                            <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
                                <span>${art.QUANTITA}x ${art.DESCRIZIONE}</span>
                                <span>€ ${art.IMPORTO.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</span>
                            </div>
                        `;
            totaleMerce += art.IMPORTO;
        });
    } else {
        listaHTML = "<i>Nessun dettaglio articoli salvato</i>";
    }

    document.getElementById('det-lista-articoli').innerHTML = listaHTML;
    document.getElementById('det-totale-merce').textContent = "€ " + totaleMerce.toLocaleString('it-IT', { minimumFractionDigits: 2 });
    document.getElementById('det-bonus').textContent = "- € " + (venditaRaw.BONUS || 0).toLocaleString('it-IT', { minimumFractionDigits: 2 });

    let pagato = venditaRaw.CONTANTI + venditaRaw.POS;
    document.getElementById('det-pagato').textContent = "€ " + pagato.toLocaleString('it-IT', { minimumFractionDigits: 2 });
    if (venditaRaw.CONTANTI > 0 && venditaRaw.POS > 0) {
        let txtContanti = venditaRaw.CONTANTI.toLocaleString('it-IT', { minimumFractionDigits: 2 });
        let txtPos = venditaRaw.POS.toLocaleString('it-IT', { minimumFractionDigits: 2 });
        document.getElementById('det-tipo-pagamento').innerHTML = `MISTO: <span style="color:#00cc66;">Contanti € ${txtContanti}</span> | <span style="color:#4d88ff;">POS € ${txtPos}</span>`;
    } else {
        document.getElementById('det-tipo-pagamento').textContent = venditaRaw.POS > 0 ? "Pagamento Elettronico (POS)" : "Contanti";
    }

    let boxPunti = document.getElementById('box-det-punti');

    if (venditaRaw.CLIENTE !== "Nessuno") {
        document.getElementById('det-saldo-punti-iniziale').textContent = `Saldo Iniziale: ${venditaRaw.SALDO_PUNTI_INIZIALE || 0} PTS`;
        document.getElementById('det-punti-guadagnati').textContent = `Punti Guadagnati: +${venditaRaw.PUNTI_CARICATI || 0}`;
        document.getElementById('det-punti-scaricati').textContent = `Punti Scaricati: -${venditaRaw.PUNTI_SCARICATI || 0}`;
        document.getElementById('det-saldo-punti').textContent = `Saldo Finale: ${venditaRaw.SALDO_PUNTI_FINALE || 0} PTS`;

        if (boxPunti) boxPunti.style.display = 'block';
    } else {
        if (boxPunti) boxPunti.style.display = 'none';
    }

    apriModale('modal-dettaglio-scontrino');
}

// ==========================================
// 🌟 LOGICA STATISTICHE (BUSINESS INTELLIGENCE)
// ==========================================
const btnStatistiche = document.getElementById('btn-statistiche');
let statTuttiClienti = [];
let statTutteVendite = [];

if (btnStatistiche) {
    btnStatistiche.addEventListener('click', async function () {
        apriModale('modal-statistiche');
        await caricaDatiStatistiche();
    });
}

async function caricaDatiStatistiche() {
    statTuttiClienti = await getAll('clienti');
    statTutteVendite = await getAll('vendite');

    calcolaSemafori();
    calcolaTopProdotti();

    document.getElementById('stat-cerca-cliente').value = '';
    document.getElementById('stat-lista-clienti-ricerca').style.display = 'none';
    document.getElementById('stat-dettaglio-cliente').style.display = 'none';
}

function calcolaSemafori() {
    let oggi = new Date();
    let countVerdi = 0, countGialli = 0, countRossi = 0;

    statTuttiClienti.forEach(c => {
        if (c.dataUltimaOperazione) {
            let dOp = new Date(c.dataUltimaOperazione);
            let diffTime = Math.abs(oggi - dOp);
            let diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            c.giorniAssenza = diffDays;

            if (diffDays <= 30) countVerdi++;
            else if (diffDays <= 60) countGialli++;
            else countRossi++;
        } else {
            c.giorniAssenza = 999;
            countRossi++;
        }
    });

    document.getElementById('stat-verdi').textContent = countVerdi;
    document.getElementById('stat-gialli').textContent = countGialli;
    document.getElementById('stat-rossi').textContent = countRossi;
}

// Apre il dettaglio del semaforo cliccato
window.mostraListaSemaforo = function (tipo) {
    let filtrati = [];
    let colore = "";
    let titolo = "";

    if (tipo === 'VERDE') { filtrati = statTuttiClienti.filter(c => c.giorniAssenza <= 30); colore = "#00cc66"; titolo = "🟢 CLIENTI ATTIVI"; }
    else if (tipo === 'GIALLO') { filtrati = statTuttiClienti.filter(c => c.giorniAssenza > 30 && c.giorniAssenza <= 60); colore = "#ffcc00"; titolo = "🟡 DA RICONTATTARE"; }
    else if (tipo === 'ROSSO') { filtrati = statTuttiClienti.filter(c => c.giorniAssenza > 60); colore = "#ff4d4d"; titolo = "🔴 CLIENTI DORMIENTI"; }

    // Mette in alto chi manca da più tempo
    filtrati.sort((a, b) => b.giorniAssenza - a.giorniAssenza);

    let html = "";
    filtrati.forEach(c => {
        let btnWa = `<a href="whatsapp://send?phone=39${c.telefono}" style="text-decoration:none; color:white; background:#25D366; padding:4px 8px; border-radius:4px; font-size:1.6vh; font-weight:bold;">💬 Contatta</a>`;
        html += `<div style="display:flex; justify-content:space-between; padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.1);">
                                    <div><b style="color:white; font-size:2vh;">${c.nome}</b><br><span style="font-size:1.6vh; color:#b3d9ff;">Assente da ${c.giorniAssenza} gg</span></div>
                                    <div style="display:flex; align-items:center;">${btnWa}</div>
                                 </div>`;
    });

    if (html === "") html = "<p style='text-align:center;'>Nessun cliente in questa categoria.</p>";

    document.getElementById('titolo-lista-semaforo').textContent = titolo;
    document.getElementById('titolo-lista-semaforo').style.color = colore;
    document.getElementById('lista-semaforo-content').innerHTML = html;

    apriModale('modal-lista-semaforo');
};

// Calcola e ordina la classifica dei prodotti (Totalmente separata)
function calcolaTopProdotti() {
    let mappaProdotti = {};

    statTutteVendite.forEach(v => {
        if (v.ARTICOLI && v.ARTICOLI.length > 0) {
            v.ARTICOLI.forEach(art => {
                let nome = art.DESCRIZIONE;
                if (nome.includes("MOVIMENTO MANUALE PUNTI")) return;

                if (!mappaProdotti[nome]) {
                    mappaProdotti[nome] = { nome: nome, quantita: 0, incasso: 0 };
                }
                mappaProdotti[nome].quantita += art.QUANTITA;
                mappaProdotti[nome].incasso += art.IMPORTO;
            });
        }
    });

    let arrayProdotti = Object.values(mappaProdotti);
    arrayProdotti.sort((a, b) => b.incasso - a.incasso); // Ordine per Incasso Maggiore

    let html = "";
    arrayProdotti.forEach(p => {
        html += `
                    <div style="display: grid; align-items: center; grid-template-columns: 2fr 1fr 1.5fr; cursor: default; border-bottom: 1px solid rgba(255,255,255,0.1); padding: 8px 5px; transition: background 0.2s;" onmouseover="this.style.backgroundColor='rgba(255,255,255,0.1)'" onmouseout="this.style.backgroundColor='transparent'">
                        <div class="col-sinistra" style="color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${p.nome}">${p.nome}</div>
                        <div class="col-centro" style="color: #b3d9ff;">${p.quantita} pz</div>
                        <div class="col-valuta" style="color: #00ffcc; font-weight: bold;">€ ${p.incasso.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                    </div>
                `;
    });

    if (html === "") html = "<div style='text-align:center; padding: 20px; color:#8888bb;'>Nessuna vendita registrata.</div>";
    document.getElementById('stat-lista-prodotti').innerHTML = html;
}

// Autocompletamento Ricerca Singolo Cliente
const inCercaStatCliente = document.getElementById('stat-cerca-cliente');
const boxRisultatiStat = document.getElementById('stat-lista-clienti-ricerca');

inCercaStatCliente.addEventListener('input', function () {
    let txt = this.value.toLowerCase().trim();
    if (txt.length < 2) { boxRisultatiStat.style.display = 'none'; return; }

    let filtrati = statTuttiClienti.filter(c => c.nome.toLowerCase().includes(txt) || c.telefono.includes(txt));

    if (filtrati.length > 0) {
        let html = "";
        filtrati.forEach(c => {
            html += `<div style="padding: 10px; border-bottom: 1px solid #eee; cursor: pointer; color: #000; font-size:1.8vh;" 
                                  onclick="selezionaClienteStatistica('${c.scheda}')"
                                  onmouseover="this.style.backgroundColor='#d8d8ff'"
                                  onmouseout="this.style.backgroundColor='transparent'">
                                <b>${c.nome}</b> (${c.telefono})
                             </div>`;
        });
        boxRisultatiStat.innerHTML = html;
        boxRisultatiStat.style.display = 'block';
    } else {
        boxRisultatiStat.style.display = 'none';
    }
});

// Mostra Resoconto Dettagliato del cliente (con storico completo 14 colonne)
window.selezionaClienteStatistica = function (schedaCliente) {
    boxRisultatiStat.style.display = 'none';
    let c = statTuttiClienti.find(x => x.scheda === schedaCliente);
    if (!c) return;

    inCercaStatCliente.value = c.nome;

    let totaleSpeso = 0;
    let totaleVisite = 0;
    let totaleBonusRiscattati = 0;
    let dataUltimoBonus = "-";
    let importoUltimoBonus = 0;
    let mappaPreferiti = {};
    let righeHtml = "";

    // 1. Filtra solo le vendite di questo cliente e ordinale dalla più recente alla più vecchia
    let venditeCliente = statTutteVendite.filter(v => v.CLIENTE === c.nome);
    venditeCliente.sort((a, b) => new Date(b.GIORNO + "T" + b.ORA) - new Date(a.GIORNO + "T" + a.ORA));

    const nomiMesi = ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu", "Lug", "Ago", "Set", "Ott", "Nov", "Dic"];

    venditeCliente.forEach(v => {
        totaleVisite++;
        totaleSpeso += (v.CONTANTI + v.POS);

        let bonusUsato = v.BONUS || 0;
        totaleBonusRiscattati += bonusUsato;

        // Calcolo data e importo ultimo bonus (essendo ordinate dalla più recente, il primo che troviamo > 0 è l'ultimo)
        if (bonusUsato > 0 && dataUltimoBonus === "-") {
            let partiData = v.GIORNO.split('-');
            dataUltimoBonus = `${partiData[2]}/${partiData[1]}/${partiData[0]}`;
            importoUltimoBonus = bonusUsato; // <-- Salviamo l'importo dell'ultimo
        }

        // Formattazione Date per la tabella
        let dataParti = v.GIORNO.split('-');
        let meseTesto = nomiMesi[parseInt(dataParti[1]) - 1];
        let giornoIT = `${dataParti[2]}/${dataParti[1]}/${dataParti[0]}`;

        // Generazione righe tabella per ogni ARTICOLO nello scontrino
        if (v.ARTICOLI && v.ARTICOLI.length > 0) {
            v.ARTICOLI.forEach((art, index) => {
                // Statistica prodotto preferito
                if (!art.DESCRIZIONE.includes("MOVIMENTO MANUALE PUNTI")) {
                    if (!mappaPreferiti[art.DESCRIZIONE]) mappaPreferiti[art.DESCRIZIONE] = 0;
                    mappaPreferiti[art.DESCRIZIONE] += art.QUANTITA;
                }

                // Per evitare di ripetere i dati di pagamento e punti su ogni riga dello stesso scontrino,
                // li stampiamo in modo visibile sulla prima riga, e li sfumiamo sulle successive (opzionale, qui li mettiamo su tutte per chiarezza DB)

                let strContanti = index === 0 ? `€ ${v.CONTANTI.toLocaleString('it-IT', { minimumFractionDigits: 2 })}` : "-";
                let strPos = index === 0 ? `€ ${v.POS.toLocaleString('it-IT', { minimumFractionDigits: 2 })}` : "-";
                let strBonus = index === 0 && bonusUsato > 0 ? `-€ ${bonusUsato.toLocaleString('it-IT', { minimumFractionDigits: 2 })}` : (index === 0 ? "€ 0,00" : "-");

                righeHtml += `
                            <div style="display: grid; align-items: center; grid-template-columns: 0.6fr 0.8fr 0.8fr 2.5fr 1fr 1fr 0.6fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr; font-size: 1.7vh; padding: 10px 5px; border-bottom: 1px solid rgba(255,255,255,0.1); cursor: default; color: #fff; transition: background 0.2s;" onmouseover="this.style.backgroundColor='rgba(255,255,255,0.1)'" onmouseout="this.style.backgroundColor='transparent'">
                                <div class="col-centro" style="color: #b3d9ff;">${meseTesto}</div>
                                <div class="col-centro">${giornoIT}</div>
                                <div class="col-centro">${v.ORA}</div>
                                <div class="col-sinistra"${art.DESCRIZIONE}">${art.DESCRIZIONE}</div>
                                <div class="col-centro">${art.CATEGORIA || '-'}</div>
                                <div class="col-valuta" style="color: #00ffcc;">€ ${art.IMPORTO.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
                                <div class="col-centro">${art.QUANTITA}</div>                       
                                <div class="col-valuta" style="color: #ffcc00;">${strContanti}</div>
                                <div class="col-valuta" style="color: #ffcc00;">${strPos}</div>
                                <div class="col-centro">${index === 0 ? v.SALDO_PUNTI_INIZIALE : "-"}</div>
                                <div class="col-centro" style="color: #00cc66;">${index === 0 ? '+' + v.PUNTI_CARICATI : "-"}</div>
                                <div class="col-centro" style="color: #ff4d4d;">${index === 0 ? '-' + v.PUNTI_SCARICATI : "-"}</div>
                                <div class="col-valuta" style="color: #ff6666;">${strBonus}</div>
                                <div class="col-centro" style="font-weight: bold; color: #fff;">${index === 0 ? v.SALDO_PUNTI_FINALE : "-"}</div>
                            </div>
                        `;
            });
        }
    });

    if (righeHtml === "") righeHtml = "<div style='padding: 20px; text-align: center; color: #8888bb;'>Nessun acquisto registrato per questo cliente.</div>";

    let scontrinoMedio = totaleVisite > 0 ? (totaleSpeso / totaleVisite) : 0;

    let preferito = "-";
    let maxQty = 0;
    for (let key in mappaPreferiti) {
        if (mappaPreferiti[key] > maxQty) {
            maxQty = mappaPreferiti[key];
            preferito = key;
        }
    }

    // Popola i dati a schermo
    document.getElementById('stat-det-nome').textContent = c.nome;
    document.getElementById('stat-det-speso').textContent = "€ " + totaleSpeso.toLocaleString('it-IT', { minimumFractionDigits: 2 });
    document.getElementById('stat-det-visite').textContent = totaleVisite;
    document.getElementById('stat-det-scontrino-medio').textContent = "€ " + scontrinoMedio.toLocaleString('it-IT', { minimumFractionDigits: 2 });
    document.getElementById('stat-det-preferito').textContent = maxQty > 0 ? `${preferito} (${maxQty} pz)` : "Nessun dato";

    // STAMPA AGGIORNATA DEI BONUS
    document.getElementById('stat-det-tot-bonus').textContent = "€ " + totaleBonusRiscattati.toLocaleString('it-IT', { minimumFractionDigits: 2 });

    if (dataUltimoBonus !== "-") {
        document.getElementById('stat-det-ultimo-bonus').textContent = `€ ${importoUltimoBonus.toLocaleString('it-IT', { minimumFractionDigits: 2 })} (${dataUltimoBonus})`;
    } else {
        document.getElementById('stat-det-ultimo-bonus').textContent = "Nessuno";
    }

    document.getElementById('stat-tabella-acquisti').innerHTML = righeHtml;

    document.getElementById('stat-dettaglio-cliente').style.display = 'flex';
};

// ============================================================
// 🌐 LOGICA DI SISTEMA E CAMBIO GIORNO (WIFI, OROLOGIO, DATA)
// ============================================================

const sysWifi = document.getElementById('sys-wifi');
const sysOrologio = document.getElementById('sys-orologio');
const sysData = document.getElementById('sys-data');

// Memoria per il cambio giorno automatico
let dataCorrenteSistema = getOggiString();

// 0. Gestione Spia Wi-Fi (Online/Offline) e Stato Menu
window.aggiornaStatoRete = function () {
    // Aggiorna la spia in alto a sinistra nella Cassa (indica solo lo stato di internet)
    if (sysWifi) {
        if (navigator.onLine) {
            sysWifi.innerHTML = '🟢 ONLINE';
            sysWifi.style.color = '#00cc66';
        } else {
            sysWifi.innerHTML = '🔴 OFFLINE';
            sysWifi.style.color = '#ff4d4d';
        }
    }

    // Aggiorna la scritta in fondo al Menu Principale (indica il vero stato del DB)
    let menuStatus = document.getElementById('menu-status-web');
    if (menuStatus) {
        if (!FIREBASE_URL || FIREBASE_URL === "") {
            menuStatus.innerHTML = '<span style="color: #ffcc00; font-weight: bold;">Manca Link DB ⚠️</span>';
        } else if (navigator.onLine) {
            menuStatus.innerHTML = '<span style="color: #00cc66; font-weight: bold;">Collegato 🟢</span>';
        } else {
            menuStatus.innerHTML = '<span style="color: #ff4d4d; font-weight: bold;">Offline 🔴</span>';
        }
    }
};

// Ascolta i cambiamenti di connessione in tempo reale
window.addEventListener('online', aggiornaStatoRete);
window.addEventListener('offline', aggiornaStatoRete);
aggiornaStatoRete(); // Controlla subito all'avvio

// 1. Gestione Orologio, Data e AZZERAMENTO MEZZANOTTE
function aggiornaOrologio() {
    const adesso = new Date();

    // Orologio
    const hh = String(adesso.getHours()).padStart(2, '0');
    const mm = String(adesso.getMinutes()).padStart(2, '0');
    const ss = String(adesso.getSeconds()).padStart(2, '0');
    if (sysOrologio) sysOrologio.textContent = `${hh}:${mm}:${ss}`;

    // Data
    const gg = String(adesso.getDate()).padStart(2, '0');
    const mese = String(adesso.getMonth() + 1).padStart(2, '0');
    const anno = adesso.getFullYear();
    if (sysData) sysData.textContent = `${gg}/${mese}/${anno}`;

    // 🌟 SENTINELLA DI MEZZANOTTE: Azzera tutto al cambio giorno
    let nuovaData = `${anno}-${mese}-${gg}`;
    if (nuovaData !== dataCorrenteSistema) {
        dataCorrenteSistema = nuovaData; // Aggiorna la memoria al nuovo giorno

        // 1. Svuota la cassa e annulla scontrini in sospeso
        if (btnCestino) btnCestino.click();

        // 2. Chiude forzatamente qualsiasi finestra/registro aperto di ieri
        document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');

        // 🔥 3. AZZERAMENTO FIREBASE (Svuota l'intero cruscotto online per il nuovo giorno)
        if (navigator.onLine) {
            fetch(`${FIREBASE_URL}/vendite_live.json`, { method: 'DELETE' }).catch(e => console.log(e));
        }

        // 4. Mostra l'avviso con la modale custom
        mostraAvvisoModale("🌙 <b>CAMBIO GIORNO EFFETTUATO</b><br><br>È scattata la mezzanotte.<br>Il registro di cassa e il cruscotto online sono stati azzerati e preparati per oggi.");

        // 5. Riporta l'operatore al menu principale per iniziare la giornata
        apriModale('modal-menu-principale');
    }
}

// Aggiorna l'orologio ogni secondo
setInterval(aggiornaOrologio, 1000);
aggiornaOrologio(); // Avvio immediato

// ====================================================
// 🏠 LOGICA MENU PRINCIPALE E NAVIGAZIONE INTELLIGENTE
// ====================================================

// Variabile di memoria per capire da dove arriviamo
let apertoDaMenu = false;

// Intercetta i click sui bottoni fisici in alto della Cassa
// Se l'utente clicca un bottone dalla Cassa, la provenienza "Menu" si cancella
document.querySelectorAll('.sezione-tasti .tasto-fisico').forEach(btn => {
    btn.addEventListener('click', () => {
        apertoDaMenu = false;
    });
});

// Nuova funzione intelligente per la chiusura dei moduli
window.chiudiModulo = function (idModal) {
    chiudiModale(idModal); // Chiude visivamente la finestra

    // Se eravamo partiti dal menu, lo riapriamo automaticamente
    if (apertoDaMenu) {
        apriModale('modal-menu-principale');
    }
};

// Funzione chiamata dai pulsanti del Menu di Avvio
window.avviaFunzione = function (tipo) {
    chiudiModale('modal-menu-principale'); // Nasconde il menu

    switch (tipo) {
        case 'CASSA':
            apertoDaMenu = false; // Azzera la memoria
            mostraMessaggio("MODALITÀ CASSA ATTIVA");
            break;
        case 'CLIENTI':
            document.getElementById('btn-clienti').click();
            apertoDaMenu = true; // Registra la memoria DOPO il click
            break;
        case 'CALENDARIO':
            document.getElementById('btn-calendario').click();
            apertoDaMenu = true;
            break;
        case 'CONTABILITA':
            document.getElementById('btn-contabilita').click();
            apertoDaMenu = true;
            break;
        case 'PUNTI':
            document.getElementById('btn-preferiti').click();
            apertoDaMenu = true;
            break;
        case 'CHIUSURA':
            document.getElementById('btn-registro').click();
            apertoDaMenu = true;
            break;
        case 'MAGAZZINO':
            document.getElementById('btn-magazzino').click();
            apertoDaMenu = true;
            break;
        case 'SETUP':
            caricaImpostazioniAvanzate();
            apriModale('modal-impostazioni-menu'); // <-- PUNTA AL NUOVO MENU MODULARE!
            apertoDaMenu = true;
            break;
        case 'STATISTICHE':
            calcolaStatistiche(); // Calcola i dati prima di aprire
            apriModale('modal-dashboard-vendite');
            apertoDaMenu = true;
            break;
    }
};

// ==========================================
// 📦 LOGICA GESTIONE MAGAZZINO
// ==========================================
const btnMagazzino = document.getElementById('btn-magazzino');
const inMagCodice = document.getElementById('mag-codice');
const inMagDescrizione = document.getElementById('mag-descrizione');
const inMagCategoria = document.getElementById('mag-categoria');
const inMagGiacenza = document.getElementById('mag-giacenza');
const inMagPrezzoAcq = document.getElementById('mag-prezzo-acq');
const inMagPrezzoVen = document.getElementById('mag-prezzo-ven');
const btnMagElimina = document.getElementById('mag-btn-elimina');
const searchMag = document.getElementById('mag-search');
const magListaHTML = document.getElementById('mag-list');

let listaMagazzinoCompleta = [];

if (btnMagazzino) {
    btnMagazzino.addEventListener('click', async function () {
        apriModale('modal-magazzino');
        await magCaricaLista();
        magNuovoProdotto();
        searchMag.value = '';
        searchMag.focus();
    });
}

// 🔥 MOTORE DISTINTA BASE: Calcola la giacenza virtuale dei prodotti finiti
function calcolaGiacenzeVirtualiBOM(magazzinoGrezzo) {
    magazzinoGrezzo.forEach(p => {
        if (p.is_kit && p.tipo_kit === 'DINAMICO' && p.componenti_kit) {
            let giacenzePossibili = p.componenti_kit.map(comp => {
                let compDb = magazzinoGrezzo.find(x => x.codice === comp.codice);
                if (!compDb || compDb.giacenza <= 0) return 0;
                // Calcola quanti pezzi finiti posso fare con questo componente
                return Math.floor(compDb.giacenza / comp.qta);
            });
            // La giacenza del profumo finito è dettata dal componente che finisce prima (collo di bottiglia)
            p.giacenza = giacenzePossibili.length > 0 ? Math.min(...giacenzePossibili) : 0;
            p.is_virtuale = true;
        }
    });
    return magazzinoGrezzo;
}

async function magCaricaLista() {
    let magazzinoGrezzo = await getAll('magazzino');
    listaMagazzinoCompleta = calcolaGiacenzeVirtualiBOM(magazzinoGrezzo); // Applica la BOM

    listaMagazzinoCompleta.sort((a, b) => a.descrizione.localeCompare(b.descrizione));
    magDisegnaLista(listaMagazzinoCompleta);
    magCalcolaStatistiche();
}

function magDisegnaLista(arrayProdotti) {
    magListaHTML.innerHTML = '';
    arrayProdotti.forEach(p => {
        let giacenzaColore = p.giacenza <= (p.scorta_minima || 5) ? '#ff4d4d' : '#b3d9ff';
        let iconaGiacenza = p.is_virtuale ? '🪄' : '📦'; // 🪄 Indica che la giacenza è virtuale (BOM)

        let div = document.createElement('div');
        div.className = 'crm-list-item';
        div.innerHTML = `
            <div class="crm-list-nome">${p.descrizione}</div>
            <div class="crm-list-dati">
                <span style="color: #ffcc00;">[${p.codice}]</span>
                <span style="color: ${giacenzaColore}; font-weight: bold;">${iconaGiacenza} ${p.giacenza} ${p.is_virtuale ? 'max' : 'pz'}</span>
                <span style="color: #00ffcc;">€ ${p.prezzo.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</span>
            </div>
        `;
        div.addEventListener('click', () => {
            document.querySelectorAll('#mag-list .crm-list-item').forEach(el => el.classList.remove('attivo'));
            div.classList.add('attivo');
            magCaricaScheda(p);
        });
        magListaHTML.appendChild(div);
    });
}

function magCalcolaStatistiche() {
    let totaleArticoli = listaMagazzinoCompleta.length;
    let valoreMagazzino = 0;

    listaMagazzinoCompleta.forEach(p => {
        // Calcola il valore in base al prezzo di acquisto (se presente), altrimenti usa il prezzo di vendita
        let prezzoRiferimento = p.prezzoAcquisto > 0 ? p.prezzoAcquisto : p.prezzo;
        let qta = parseInt(p.giacenza) || 0;
        valoreMagazzino += (prezzoRiferimento * qta);
    });

    document.getElementById('mag-stat-articoli').textContent = totaleArticoli;
    document.getElementById('mag-stat-valore').textContent = "€ " + valoreMagazzino.toLocaleString('it-IT', { minimumFractionDigits: 2 });
}

searchMag.addEventListener('input', function () {
    let t = this.value.toLowerCase().trim();
    if (t === '') { magDisegnaLista(listaMagazzinoCompleta); return; }
    let filtrati = listaMagazzinoCompleta.filter(p =>
        p.descrizione.toLowerCase().includes(t) ||
        p.codice.toLowerCase().includes(t) ||
        (p.categoria && p.categoria.toLowerCase().includes(t))
    );
    magDisegnaLista(filtrati);
});

// --- NUOVE VARIABILI E FUNZIONI PER MAGAZZINO AVANZATO E KIT ---
let kitComponentiAttuali = [];

window.calcolaMargine = function () {
    let acq = parseFloat(document.getElementById('mag-prezzo-acq').value.replace(',', '.')) || 0;
    let ven = parseFloat(document.getElementById('mag-prezzo-ven').value.replace(',', '.')) || 0;
    let margineDisplay = document.getElementById('mag-margine-calc');

    if (ven > 0) {
        let margine = ((ven - acq) / ven) * 100;
        margineDisplay.textContent = margine.toFixed(2) + '%';
        margineDisplay.style.color = margine < 30 ? '#ff6666' : '#00ffcc';
    } else {
        margineDisplay.textContent = '0.00%';
        margineDisplay.style.color = '#b3d9ff';
    }
};

window.toggleSezioneKit = function () {
    let checked = document.getElementById('mag-is-kit').checked;
    document.getElementById('sezione-composizione-kit').style.display = checked ? 'flex' : 'none';
};

function ridisegnaComponentiKit() {
    let container = document.getElementById('mag-tabella-componenti');
    let costoTeorico = 0;
    container.innerHTML = '';

    if (kitComponentiAttuali.length === 0) {
        container.innerHTML = '<div style="text-align: center; color: #888; font-size: 1.6vh; padding-top: 20px;">Nessun componente aggiunto alla Distinta Base.</div>';
    } else {
        kitComponentiAttuali.forEach((c, idx) => {
            costoTeorico += (c.prezzoAcquisto * c.qta);
            let row = document.createElement('div');
            row.className = 'kit-component-item';
            row.innerHTML = `
                <div style="flex: 2; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${c.descrizione}</div>
                <div style="flex: 1; text-align: center; color: #00ffcc;">Costo unit.: €${c.prezzoAcquisto.toFixed(2)}</div>
                <div style="flex: 0.5; display: flex; align-items: center; gap: 5px;">
                    <span style="color: #b3d9ff;">Q.tà:</span>
                    <input type="number" step="0.01" min="0.01" value="${c.qta}" style="width: 50px; text-align: center; border-radius: 3px; border: none; padding: 2px;" onchange="aggiornaQtaKit(${idx}, this.value)">
                </div>
                <button class="btn-rimuovi-comp" onclick="rimuoviDaKit(${idx})">❌</button>
            `;
            container.appendChild(row);
        });
    }

    let labelCosto = document.getElementById('mag-kit-costo-calc');
    if (labelCosto) labelCosto.textContent = '€ ' + costoTeorico.toLocaleString('it-IT', { minimumFractionDigits: 2 });

    // 🔥 AUTOMAZIONE: Compila il Costo d'Acquisto per il calcolo del Margine
    let inputAcq = document.getElementById('mag-prezzo-acq');
    if (inputAcq && document.getElementById('mag-is-kit').checked) {
        inputAcq.value = costoTeorico.toFixed(2).replace('.', ',');
        calcolaMargine();
    }
}

window.aggiornaQtaKit = function (index, nuovaQta) {
    let qta = parseFloat(nuovaQta); // parseFloat permette i decimali (ml)
    if (qta > 0) { kitComponentiAttuali[index].qta = qta; ridisegnaComponentiKit(); }
};

window.rimuoviDaKit = function (index) {
    kitComponentiAttuali.splice(index, 1);
    ridisegnaComponentiKit();
};

// ========================================================
// NAVIGAZIONE CON FRECCE E INVIO - RICERCA KIT
// ========================================================
let indiceRicercaKit = -1;

document.getElementById('mag-cerca-kit').addEventListener('input', async function () {
    indiceRicercaKit = -1; // Resetta l'indice ad ogni nuova lettera
    let txt = this.value.toLowerCase().trim();
    let listaHTML = document.getElementById('lista-ricerca-kit');
    listaHTML.innerHTML = '';

    if (txt.length < 2) { listaHTML.style.display = 'none'; return; }

    let magazzinoCompleto = await getAll('magazzino');
    let filtrati = magazzinoCompleto.filter(p => !p.is_kit && (p.codice.toLowerCase().includes(txt) || p.descrizione.toLowerCase().includes(txt)));

    if (filtrati.length > 0) {
        listaHTML.style.display = 'flex';
        filtrati.forEach(p => {
            let div = document.createElement('div');
            div.className = 'voce-lista';
            div.style.padding = '10px';
            div.style.cursor = 'pointer';
            div.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
            div.innerHTML = `<span style="color:#666;">[${p.codice}]</span> ${p.descrizione}`;

            div.addEventListener('click', () => {
                let check = kitComponentiAttuali.find(x => x.codice === p.codice);
                if (check) { check.qta++; }
                else { kitComponentiAttuali.push({ codice: p.codice, descrizione: p.descrizione, prezzoAcquisto: p.prezzoAcquisto || 0, qta: 1 }); }
                ridisegnaComponentiKit();
                document.getElementById('mag-cerca-kit').value = '';
                listaHTML.style.display = 'none';
                indiceRicercaKit = -1; // Reset dopo la selezione
            });
            listaHTML.appendChild(div);
        });
    } else {
        listaHTML.style.display = 'none';
    }
});

// Ascoltatore della Tastiera per il Modulo Kit
document.getElementById('mag-cerca-kit').addEventListener('keydown', function (e) {
    let listaHTML = document.getElementById('lista-ricerca-kit');
    let elementi = listaHTML.querySelectorAll('div.voce-lista');

    if (listaHTML.style.display === 'none' || elementi.length === 0) return;

    if (e.key === 'ArrowDown') {
        e.preventDefault(); // Evita che il cursore scatti nel campo di testo
        indiceRicercaKit++;
        if (indiceRicercaKit >= elementi.length) indiceRicercaKit = 0; // Torna all'inizio
        evidenziaVoceKit(elementi);
    }
    else if (e.key === 'ArrowUp') {
        e.preventDefault();
        indiceRicercaKit--;
        if (indiceRicercaKit < 0) indiceRicercaKit = elementi.length - 1; // Va alla fine
        evidenziaVoceKit(elementi);
    }
    else if (e.key === 'Enter') {
        e.preventDefault();
        if (indiceRicercaKit >= 0 && elementi[indiceRicercaKit]) {
            elementi[indiceRicercaKit].click(); // Seleziona la voce evidenziata
        } else if (elementi.length === 1) {
            elementi[0].click(); // Se c'è un solo risultato, l'invio lo prende in automatico!
        }
    }
});

function evidenziaVoceKit(elementi) {
    // Rimuove l'evidenziazione da tutte le voci
    elementi.forEach(el => {
        el.style.backgroundColor = '';
        el.style.color = '';
        el.style.borderLeft = '';
    });

    // Applica lo stile azzurro in tema con il gestionale alla voce attiva
    if (indiceRicercaKit >= 0 && elementi[indiceRicercaKit]) {
        let attivo = elementi[indiceRicercaKit];
        attivo.style.backgroundColor = 'rgba(77, 136, 255, 0.3)';
        attivo.style.color = '#ffffff';
        attivo.style.borderLeft = '4px solid #4d88ff';
        // Fa scorrere la lista automaticamente se l'elemento va fuori campo
        attivo.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

function magCaricaScheda(p) {
    document.getElementById('mag-titolo-scheda').textContent = "MODIFICA ARTICOLO";
    document.getElementById('mag-codice').value = p.codice;
    document.getElementById('mag-codice').disabled = true;
    document.getElementById('btn-genera-mag-codice').style.display = 'none';

    document.getElementById('mag-categoria').value = p.categoria || "VARIE";
    document.getElementById('mag-descrizione').value = p.descrizione;
    document.getElementById('mag-brand').value = p.brand || "";
    document.getElementById('mag-linea').value = p.linea || "";
    document.getElementById('mag-formato').value = p.formato || "";
    document.getElementById('mag-note').value = p.note_olfattive || "";
    document.getElementById('mag-giacenza').value = p.giacenza;
    document.getElementById('mag-ubicazione').value = p.ubicazione || "";
    document.getElementById('mag-lotto').value = p.scadenza_lotto || "";
    document.getElementById('mag-scorta-min').value = p.scorta_minima || "0";

    document.getElementById('mag-prezzo-acq').value = (p.prezzoAcquisto || 0).toLocaleString('it-IT', { minimumFractionDigits: 2 });
    document.getElementById('mag-prezzo-ven').value = (p.prezzo || 0).toLocaleString('it-IT', { minimumFractionDigits: 2 });
    document.getElementById('mag-prezzo-promo').value = (p.prezzo_promo || 0).toLocaleString('it-IT', { minimumFractionDigits: 2 });
    document.getElementById('mag-iva').value = p.iva || "22";

    document.getElementById('mag-is-tester').checked = !!p.is_tester;
    document.getElementById('mag-punti-fedelta').value = p.punti_fedelta || "0";

    document.getElementById('mag-is-kit').checked = !!p.is_kit;
    document.getElementById('mag-tipo-kit').value = p.tipo_kit || "DINAMICO";
    document.getElementById('btn-converti-tester').style.display = 'block';
    document.getElementById('mag-fornitore').value = p.fornitore || "";
    document.getElementById('mag-inci').value = p.inci || "";
    document.getElementById('mag-is-formato-spina').checked = p.is_formato_spina || false;
    document.getElementById('mag-volume-spina').value = p.volume_spina || "";
    kitComponentiAttuali = p.componenti_kit ? JSON.parse(JSON.stringify(p.componenti_kit)) : [];

    toggleSezioneKit();
    ridisegnaComponentiKit();
    calcolaMargine();
    document.getElementById('mag-btn-elimina').style.display = 'block';
}

window.magNuovoProdotto = function () {
    document.getElementById('mag-titolo-scheda').textContent = "NUOVO ARTICOLO";
    document.getElementById('mag-codice').value = '';
    document.getElementById('mag-codice').disabled = false;
    document.getElementById('btn-genera-mag-codice').style.display = 'block';

    document.getElementById('mag-categoria').value = '';
    document.getElementById('mag-descrizione').value = '';
    document.getElementById('mag-brand').value = '';
    document.getElementById('mag-linea').value = '';
    document.getElementById('mag-formato').value = '';
    document.getElementById('mag-note').value = '';
    document.getElementById('mag-giacenza').value = '0';
    document.getElementById('mag-ubicazione').value = '';
    document.getElementById('mag-lotto').value = '';
    document.getElementById('mag-scorta-min').value = '0';

    document.getElementById('mag-prezzo-acq').value = '';
    document.getElementById('mag-prezzo-ven').value = '';
    document.getElementById('mag-prezzo-promo').value = '';
    document.getElementById('mag-iva').value = '22';

    document.getElementById('mag-is-tester').checked = false;
    document.getElementById('mag-punti-fedelta').value = '0';

    document.getElementById('mag-is-kit').checked = false;
    document.getElementById('mag-tipo-kit').value = "DINAMICO";
    document.getElementById('btn-converti-tester').style.display = 'none';
    document.getElementById('mag-fornitore').value = '';
    document.getElementById('mag-inci').value = "";
    document.getElementById('mag-is-formato-spina').checked = false;
    document.getElementById('mag-volume-spina').value = "";
    kitComponentiAttuali = [];

    toggleSezioneKit();
    ridisegnaComponentiKit();
    calcolaMargine();
    document.getElementById('mag-btn-elimina').style.display = 'none';
    document.querySelectorAll('#mag-list .crm-list-item').forEach(el => el.classList.remove('attivo'));
    document.getElementById('mag-codice').focus();
};

window.magSalvaProdotto = async function () {
    let codice = document.getElementById('mag-codice').value.trim();
    let descrizione = document.getElementById('mag-descrizione').value.trim().toUpperCase();
    let prezzoVen = parseFloat(document.getElementById('mag-prezzo-ven').value.replace(',', '.')) || 0;

    // Controllo aggiornato: accetta il prezzo a 0, blocca solo se negativo o se mancano codice/descrizione
    if (codice === '' || descrizione === '' || prezzoVen < 0) {
        mostraAvvisoModale("Compila i campi obbligatori:<br>- Codice<br>- Descrizione<br>(Il prezzo di vendita non può essere negativo)");
        return;
    }

    let isKit = document.getElementById('mag-is-kit').checked;
    if (isKit && kitComponentiAttuali.length === 0) {
        mostraAvvisoModale("Hai abilitato il Kit, ma non hai inserito alcun componente. Aggiungi i componenti o disabilita il Kit.");
        return;
    }

    let nuovoProdotto = {
        codice: codice,
        categoria: document.getElementById('mag-categoria').value,
        fornitore: document.getElementById('mag-fornitore').value.trim().toUpperCase(),
        descrizione: descrizione,
        brand: document.getElementById('mag-brand').value.trim(),
        linea: document.getElementById('mag-linea').value.trim(),
        formato: document.getElementById('mag-formato').value.trim(),
        note_olfattive: document.getElementById('mag-note').value.trim(),
        giacenza: parseInt(document.getElementById('mag-giacenza').value) || 0,
        ubicazione: document.getElementById('mag-ubicazione').value.trim(),
        scadenza_lotto: document.getElementById('mag-lotto').value.trim(),
        scorta_minima: parseInt(document.getElementById('mag-scorta-min').value) || 0,
        prezzoAcquisto: parseFloat(document.getElementById('mag-prezzo-acq').value.replace(',', '.')) || 0,
        prezzo: prezzoVen,
        prezzo_promo: parseFloat(document.getElementById('mag-prezzo-promo').value.replace(',', '.')) || 0,
        iva: parseInt(document.getElementById('mag-iva').value) || 22,
        is_tester: document.getElementById('mag-is-tester').checked,
        punti_fedelta: parseInt(document.getElementById('mag-punti-fedelta').value) || 0,
        is_kit: isKit,
        tipo_kit: isKit ? document.getElementById('mag-tipo-kit').value : null,
        componenti_kit: isKit ? JSON.parse(JSON.stringify(kitComponentiAttuali)) : null,
        inci: document.getElementById('mag-inci').value.trim(),
        is_formato_spina: document.getElementById('mag-is-formato-spina').checked,
        volume_spina: parseInt(document.getElementById('mag-volume-spina').value) || 0,
        tipo: "PZ"
    };

    let tx = db.transaction('magazzino', 'readwrite');
    let store = tx.objectStore('magazzino');
    store.put(nuovoProdotto);

    tx.oncomplete = async () => {
        if (typeof salvaProdottoCloud === "function") salvaProdottoCloud(nuovoProdotto);
        document.getElementById('mag-titolo-scheda').textContent = "✅ SALVATO!";
        document.getElementById('mag-titolo-scheda').style.color = "#00ff00";
        setTimeout(() => { document.getElementById('mag-titolo-scheda').textContent = "MODIFICA ARTICOLO"; document.getElementById('mag-titolo-scheda').style.color = "white"; }, 1500);
        await magCaricaLista();
        document.getElementById('mag-codice').disabled = true;
        document.getElementById('mag-btn-elimina').style.display = 'block';
    };
};

// 🌟 GENERATORE CODICI A BARRE INTERNI (Iniziano con 210)
window.generaCodiceMagazzinoUnivoco = async function () {
    let unico = false;
    let nuovoCodice = "";
    let btnGen = document.getElementById('btn-genera-mag-codice');
    btnGen.innerHTML = "⏳...";

    while (!unico) {
        // Crea un numero di 13 cifre che inizia con '210' (standard codici interni)
        let cifreRandom = Math.floor(Math.random() * 10000000000).toString().padStart(10, '0');
        nuovoCodice = "210" + cifreRandom;

        // Controlla nel DB se esiste già
        let magazzinoCompleto = await getAll('magazzino');
        let esiste = magazzinoCompleto.find(p => p.codice === nuovoCodice);
        if (!esiste) {
            unico = true;
        }
    }

    document.getElementById('mag-codice').value = nuovoCodice;
    btnGen.innerHTML = "🎲";
    document.getElementById('mag-categoria').focus(); // Passa al campo successivo
};

// Filtri per far scrivere solo numeri nei campi importo/giacenza
inMagGiacenza.addEventListener('input', function () { this.value = this.value.replace(/[^0-9-]/g, ''); });
inMagPrezzoVen.addEventListener('input', function () { this.value = this.value.replace(/[^0-9.,]/g, ''); });
inMagPrezzoAcq.addEventListener('input', function () { this.value = this.value.replace(/[^0-9.,]/g, ''); });

// ==========================================
// 🔥 CONNESSIONE FIREBASE REALTIME DATABASE
// ==========================================
// 1. Aggiorna il nodo principale del cliente (Solo Punti e Data)
async function aggiornaFidelityFirebase(numeroScheda, nuoviPunti, dataOperazione) {
    if (!navigator.onLine) return;

    // 🔥 FIX CRITICO: Scudo Anti-Orfani per Firebase
    if (!numeroScheda || String(numeroScheda).trim() === '') return;

    const url = `${FIREBASE_URL}/clienti/${numeroScheda}/fidelity.json`;
    const payload = {
        punti: nuoviPunti,
        ultima_operazione: dataOperazione
    };

    try {
        await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (e) {
        console.warn("Sincronizzazione Firebase PATCH fallita:", e);
    }
}

// 2. Crea il log "Messaggio" con lo storico della transazione
async function firebasePushNotifiche(numeroScheda, saldoIniziale, puntiCaricati, puntiScaricati, saldoPunti, bonus) {
    if (!navigator.onLine) return;

    // 🔥 FIX CRITICO: Scudo Anti-Orfani per Firebase
    if (!numeroScheda || String(numeroScheda).trim() === '') return;

    const url = `${FIREBASE_URL}/clienti/${numeroScheda}/messaggi.json`;
    const oggi = new Date();

    const payload = {
        tipo: "transazione", // <-- FONDAMENTALE PER L'APP
        saldo_iniziale: saldoIniziale.toFixed(2),
        punti_caricati: puntiCaricati.toFixed(2),
        punti_scaricati: puntiScaricati.toFixed(2),
        saldo_punti: saldoPunti.toFixed(2),
        bonus: bonus.toFixed(2),
        data: `${String(oggi.getDate()).padStart(2, '0')}/${String(oggi.getMonth() + 1).padStart(2, '0')}/${oggi.getFullYear()}`,
        ora: `${String(oggi.getHours()).padStart(2, '0')}:${String(oggi.getMinutes()).padStart(2, '0')}:${String(oggi.getSeconds()).padStart(2, '0')}`,
        timestamp: Math.floor(oggi.getTime() / 1000)
    };

    try {
        await fetch(url, {
            method: 'POST', // POST crea un nuovo ID univoco dentro la cartella messaggi
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (e) {
        console.warn("Sincronizzazione Firebase POST fallita:", e);
    }
}

// ==========================================
// ⚙️ LOGICA IMPOSTAZIONI E BACKUP
// ==========================================

// 1. Esportazione CSV (Leggibile da Excel)
window.esportaDatiCSV = async function (tabella) {
    let dati = await getAll(tabella);
    if (dati.length === 0) {
        mostraAvvisoModale(`Nessun dato presente in "${tabella}".`);
        return;
    }

    let csvContent = "data:text/csv;charset=utf-8,";

    // Crea intestazioni
    let keys = Object.keys(dati[0]);
    // Filtra l'array complesso degli articoli per le vendite, per non spaccare il CSV
    if (tabella === 'vendite') keys = keys.filter(k => k !== 'ARTICOLI');

    csvContent += keys.join(";") + "\r\n";

    // Aggiungi i dati
    dati.forEach(row => {
        let rowData = keys.map(k => {
            let cella = row[k] !== undefined && row[k] !== null ? row[k].toString() : "";
            // Pulisci i dati da virgole o a capo che rompono il CSV
            cella = cella.replace(/"/g, '""').replace(/\n/g, ' ');
            return `"${cella}"`;
        });
        csvContent += rowData.join(";") + "\r\n";
    });

    // Avvia download
    let encodedUri = encodeURI(csvContent);
    let link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `export_${tabella}_${getOggiString()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    mostraAvvisoModale(`Esportazione di ${dati.length} righe completata con successo!`);
};

// ==========================================
// 🛡️ MODULO SICUREZZA E BACKUP A 3 LIVELLI
// ==========================================

// 1. ALLARME BLOCCANTE ALL'AVVIO (Controllo 24 ore)
document.addEventListener("DOMContentLoaded", function () {
    setTimeout(() => {
        let ultimoBackup = localStorage.getItem('gestionale_ultimo_backup');
        let oraAttuale = new Date().getTime();

        // Se non c'è traccia di backup o sono passate più di 24 ore (86400000 ms)
        if (!ultimoBackup || (oraAttuale - parseInt(ultimoBackup)) > 86400000) {
            mostraAvvisoModale("⚠️ <b>ALLARME SICUREZZA DATI</b> ⚠️<br><br>Il sistema non rileva un backup di sicurezza completato con successo nelle ultime 24 ore.<br><br>Vai in <b>Impostazioni -> Salvataggio e Dati</b> ed esegui immediatamente un <b>ESPORTA BACKUP</b> per prevenire la perdita dei dati.");
        }
    }, 3000); // Ritardo per far caricare l'interfaccia senza bloccare il PIN
});

// 2. FUNZIONE DI BACKUP (Manuale o Automatico Silente)
window.esportaBackupCompleto = async function (isAutomatico = false) {
    try {
        if (!isAutomatico) mostraAvvisoModale("⏳ Preparazione del pacchetto di sicurezza in corso. Non chiudere la pagina...");

        // Raccoglie la totalità degli archivi
        let backup = {
            metadata: {
                data_creazione: new Date().toISOString(),
                tipo_backup: isAutomatico ? "AUTOMATICO_4H" : "MANUALE_OFFSITE",
                versione_sistema: "3.2"
            },
            clienti: await getAll('clienti'),
            vendite: await getAll('vendite'),
            magazzino: await getAll('magazzino'),
            movimenti_cassa: await getAll('movimenti_cassa'),
            giftcards: await getAll('giftcards'),
            ordini: await getAll('ordini'),
            vouchers: await getAll('vouchers'),
            chiusure: await getAll('chiusure')
        };

        // Aggiorna la "marca da bollo" dell'ultimo backup riuscito
        let timestamp = new Date().getTime();
        localStorage.setItem('gestionale_ultimo_backup', timestamp.toString());

        let jsonString = JSON.stringify(backup);

        if (isAutomatico) {
            // BACKUP LOCALE (Livello 1): Salva uno snapshot nascosto nel LocalStorage per emergenze rapide
            try {
                localStorage.setItem('gestionale_backup_locale_emergenza', jsonString);
                console.log("🛡️ Backup di sicurezza 4H eseguito silenziosamente in background.");
            } catch (e) { console.warn("Memoria locale piena, snapshot saltato.", e); }
        } else {
            // BACKUP OFFSITE (Livello 3): Esportazione fisica ultra-sicura tramite Blob
            let blob = new Blob([jsonString], { type: "application/json" });
            let url = URL.createObjectURL(blob);
            let link = document.createElement("a");
            link.href = url;

            let d = new Date();
            let dataFormattata = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            let oraFormattata = String(d.getHours()).padStart(2, '0') + "-" + String(d.getMinutes()).padStart(2, '0');

            link.setAttribute("download", `Backup_Gestionale_COMPLETO_${dataFormattata}_${oraFormattata}.json`);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url); // Pulisce la RAM

            setTimeout(() => {
                mostraAvvisoModale("✅ <b>Backup completato con successo!</b><br><br>Salva il file appena scaricato su una <b>Pendrive USB</b> o un <b>Hard Disk esterno</b> e scollegalo dal PC per la massima sicurezza.");
            }, 1000);
        }
    } catch (error) {
        console.error("❌ Errore critico durante il backup:", error);
        if (!isAutomatico) mostraAvvisoModale("❌ ERRORE CRITICO: Impossibile generare il file di backup. Contattare l'assistenza.");
    }
};

// 2.5 Ripristino Backup Totale da file JSON (Aggiornato per tutti gli archivi)
window.importaBackupJSON = function (event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function (e) {
        try {
            let backup = JSON.parse(e.target.result);

            // Apriamo una transazione su tutti gli store esistenti
            let tx = db.transaction(['clienti', 'vendite', 'magazzino', 'movimenti_cassa', 'giftcards', 'ordini', 'vouchers', 'chiusure'], 'readwrite');

            let categorieDaAggiungere = new Set(); // 🔥 NUOVO: Raccoglitore categorie

            if (backup.clienti) backup.clienti.forEach(c => tx.objectStore('clienti').put(c));
            if (backup.vendite) backup.vendite.forEach(v => tx.objectStore('vendite').put(v));

            // Scansione Magazzino per estrapolare le Categorie
            if (backup.magazzino) {
                backup.magazzino.forEach(m => {
                    tx.objectStore('magazzino').put(m);
                    if (m.categoria && m.categoria.trim() !== '') {
                        categorieDaAggiungere.add(m.categoria.toUpperCase());
                    }
                });
            }

            if (backup.movimenti_cassa) backup.movimenti_cassa.forEach(mc => tx.objectStore('movimenti_cassa').put(mc));
            if (backup.giftcards) backup.giftcards.forEach(gc => tx.objectStore('giftcards').put(gc));
            if (backup.ordini) backup.ordini.forEach(o => tx.objectStore('ordini').put(o));
            if (backup.vouchers) backup.vouchers.forEach(vo => tx.objectStore('vouchers').put(vo));
            if (backup.chiusure) backup.chiusure.forEach(ch => tx.objectStore('chiusure').put(ch));

            tx.oncomplete = () => {
                // 🔥 AGGIORNAMENTO CATEGORIE IN BACKGROUND
                if (categorieDaAggiungere.size > 0) {
                    let catsAttuali = typeof getCategorieMagazzino === "function" ? getCategorieMagazzino() : ["PROFUMERIA", "COSMETICA", "MAKE-UP", "GADGET", "VARIE"];
                    let setCats = new Set(catsAttuali);
                    categorieDaAggiungere.forEach(c => setCats.add(c));

                    if (typeof salvaCategorieMagazzino === "function") {
                        salvaCategorieMagazzino(Array.from(setCats));
                    }
                    if (typeof popolaSelectCategorie === "function") {
                        popolaSelectCategorie(); // Aggiorna visivamente i dropdown a schermo
                    }
                }

                mostraAvvisoModale("✅ <b>Backup ripristinato con successo!</b><br><br>Tutti i dati e le categorie sono stati ricaricati nel sistema.");
                event.target.value = '';
            };
        } catch (error) {
            mostraAvvisoModale("❌ Errore durante la lettura del file. Assicurati che sia un file JSON di backup valido generato dal sistema.");
            console.error(error);
        }
    };
    reader.readAsText(file);
};

// 3. SCHEDULATORE AUTOMATICO (Ogni 4 ore)
setInterval(() => {
    esportaBackupCompleto(true); // Esegue il backup silente
}, 14400000); // 14.400.000 ms = 4 ore esatte

// 3. Sistema di Reset (Svuota Archivi)
let tipoResetSelezionato = "";

window.preparaReset = function (tipo) {
    tipoResetSelezionato = tipo;
    let msg = "";
    if (tipo === 'vendite') {
        msg = "Stai per <b>CANCELLARE TUTTO LO STORICO DELLE VENDITE E DEI MOVIMENTI DI CASSA</b>.<br><br>Magazzino e Clienti non verranno toccati.<br>Procedere?";
    } else if (tipo === 'tutto') {
        msg = "Stai per <b>AZZERARE COMPLETAMENTE IL GESTIONALE</b>.<br>Vendite, Clienti, Magazzino e Movimenti verranno eliminati definitivamente.<br><br>Consigliamo di fare prima un Backup Totale. Procedere?";
    }
    document.getElementById('msg-conferma-reset').innerHTML = msg;
    apriModale('modal-conferma-reset');
};

window.eseguiResetDatabase = async function () {
    chiudiModale('modal-conferma-reset');
    chiudiModale('modal-impostazioni');

    if (tipoResetSelezionato === 'vendite' || tipoResetSelezionato === 'tutto') {
        let tx = db.transaction(['vendite', 'movimenti_cassa'], 'readwrite');
        tx.objectStore('vendite').clear();
        tx.objectStore('movimenti_cassa').clear();
    }

    if (tipoResetSelezionato === 'tutto') {
        let tx2 = db.transaction(['clienti', 'magazzino'], 'readwrite');
        tx2.objectStore('clienti').clear();
        tx2.objectStore('magazzino').clear();
    }

    mostraAvvisoModale("Operazione di pulizia database completata con successo.<br>La pagina verrà ricaricata.");

    setTimeout(() => {
        window.location.reload();
    }, 3000);
};

// 4. Importazione dati da CSV (Excel salvato come CSV)
window.gestisciImportazioneCSV = function (event, tabella) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function (e) {
        const text = e.target.result;
        const righe = text.split('\n').filter(riga => riga.trim() !== '');

        if (righe.length <= 1) {
            mostraAvvisoModale("Il file CSV sembra vuoto o manca delle intestazioni.");
            event.target.value = '';
            return;
        }

        const separatore = righe[0].includes(';') ? ';' : ',';
        const intestazioni = righe[0].split(separatore).map(h => h.trim().replace(/"/g, '').toLowerCase());

        let conteggioAggiunti = 0;
        let venditeDaSalvare = [];
        let movimentiDaSalvare = [];
        let venditaCorrente = null;
        let categorieDaAggiungere = new Set();

        for (let i = 1; i < righe.length; i++) {
            const valori = righe[i].split(separatore).map(v => v.trim().replace(/"/g, ''));
            if (valori.length < intestazioni.length - 1) continue;

            let record = {};
            intestazioni.forEach((chiave, index) => {
                record[chiave] = valori[index] || "";
            });

            if (tabella === 'clienti') {
                let nome = record.nome || record.cliente || "CLIENTE SENZA NOME";
                let telefono = record.telefono || record.cellulare || record.tel || "";
                let scheda = record.scheda || record.card || record.codice || ("200" + Math.floor(Math.random() * 10000000000).toString().padStart(10, '0'));

                let strPunti = String(record.punti || "0").replace(/[^0-9,\-]/g, '').replace(',', '.');
                let punti = parseFloat(strPunti) || 0;
                let bonus = Math.floor(punti / 100) * 10;

                let nuovoCliente = { scheda: scheda, nome: nome.toUpperCase(), telefono: telefono, punti: punti, bonus: bonus, dataUltimaOperazione: getOggiString() };
                await updateCliente(nuovoCliente);
                conteggioAggiunti++;
            }
            else if (tabella === 'magazzino') {
                let codiceOriginale = record.codice || record.barcode || record.ean || "";

                // 🛑 CONTROLLO SALVA-VITA: Blocca i codici scientifici di Excel
                if (codiceOriginale.toUpperCase().includes('E+')) {
                    mostraAvvisoModale(`❌ <b>ERRORE CRITICO NEI CODICI</b><br><br>Il file CSV contiene codici a barre troncati in formato scientifico (es. <b>${codiceOriginale}</b>).<br><br><b>COME RISOLVERE:</b><br>1. Apri il tuo file originale in Excel.<br>2. Seleziona la colonna dei codici.<br>3. Cambia il formato in <b>Numero</b> (con 0 decimali).<br>4. Salva di nuovo in formato CSV e riprova.`);
                    event.target.value = ''; // Resetta l'input file
                    return; // Interrompe immediatamente tutta l'importazione
                }

                let codice = codiceOriginale || ("210" + Math.floor(Math.random() * 10000000000).toString().padStart(10, '0'));
                let descrizione = record.descrizione || record.articolo || record.nome || "ARTICOLO SCONOSCIUTO";
                let categoria = (record.categoria || record.reparto || "VARIE").toUpperCase();

                if (categoria !== "") categorieDaAggiungere.add(categoria);

                let strGiac = String(record.giacenza || record.quantita || "0").replace(/[^0-9,\-]/g, '');
                let strVen = String(record.prezzo || record.prezzovendita || record.listino || "0").replace(/[^0-9,\-]/g, '').replace(',', '.');
                let strAcq = String(record.prezzoacquisto || record.costo || "0").replace(/[^0-9,\-]/g, '').replace(',', '.');
                let strScorta = String(record.scorta || record.scortaminima || record.minimo || "0").replace(/[^0-9]/g, '');

                let giacenza = parseInt(strGiac) || 0;
                let prezzoVen = parseFloat(strVen) || 0;
                let prezzoAcq = parseFloat(strAcq) || 0;
                let scorta_min = parseInt(strScorta) || 0;

                let tx = db.transaction('magazzino', 'readwrite');
                let store = tx.objectStore('magazzino');
                let nuovoProdotto = {
                    codice: codice,
                    descrizione: descrizione.toUpperCase(),
                    categoria: categoria,
                    giacenza: giacenza,
                    prezzoAcquisto: prezzoAcq,
                    prezzo: prezzoVen,
                    scorta_minima: scorta_min,
                    tipo: "PZ"
                };

                store.put(nuovoProdotto);
                if (typeof salvaProdottoCloud === "function") salvaProdottoCloud(nuovoProdotto);
                conteggioAggiunti++;
            }
            else if (tabella === 'vendite') {
                let isMultipla = (record.multiple || "").toLowerCase() === 'c';
                let dataExcel = record.giorno || record.data || getOggiString();

                if (dataExcel.includes('/')) {
                    let parti = dataExcel.split('/');
                    if (parti.length === 3) {
                        let anno = parti[2].length === 2 ? "20" + parti[2] : parti[2];
                        let mese = parti[1].padStart(2, '0');
                        let giorno = parti[0].padStart(2, '0');
                        dataExcel = `${anno}-${mese}-${giorno}`;
                    }
                }

                let ora = record.ora || "12:00";
                let cliente = record.cliente || record.nome || "Nessuno";
                let desc = record.descrizione || record.articoli || "VENDITA STORICA EXCEL";
                let cat = (record['categ.'] || record.categoria || record.categ || "STORICO").toUpperCase();

                let importoMerce = parseFloat(String(record.importo || "0").replace(/[^0-9,\-]/g, '').replace(',', '.')) || 0;
                let contanti = parseFloat(String(record.contanti || "0").replace(/[^0-9,\-]/g, '').replace(',', '.')) || 0;

                if (cat === 'USCITA' || cliente.toUpperCase() === 'USCITA DI CASSA') {
                    if (venditaCorrente) { venditeDaSalvare.push(venditaCorrente); venditaCorrente = null; }
                    movimentiDaSalvare.push({ data: dataExcel, ora: ora, tipo: "USCITA", importo: importoMerce > 0 ? importoMerce : contanti, descrizione: desc });
                    continue;
                }

                if (cat === 'DISTRIBUTORE' || cliente.toUpperCase() === 'INCASSO DISTRIBUTORE') {
                    if (venditaCorrente) { venditeDaSalvare.push(venditaCorrente); venditaCorrente = null; }
                    movimentiDaSalvare.push({ data: dataExcel, ora: ora, tipo: "ENTRATA", importo: importoMerce > 0 ? importoMerce : contanti, descrizione: desc });
                    continue;
                }

                let qta = parseInt(String(record['q.tà'] || record.quantita || record.qta || "1").replace(/[^0-9,\-]/g, '')) || 1;
                let pos = parseFloat(String(record.pos || record.carta || "0").replace(/[^0-9,\-]/g, '').replace(',', '.')) || 0;

                let sIniz = parseFloat(String(record['s. iniz.'] || "0").replace(/[^0-9,\-]/g, '').replace(',', '.')) || 0;
                let pCaric = parseFloat(String(record['p. caric.'] || "0").replace(/[^0-9,\-]/g, '').replace(',', '.')) || 0;
                let pScaric = parseFloat(String(record['p. scaric.'] || "0").replace(/[^0-9,\-]/g, '').replace(',', '.')) || 0;
                let bonus = parseFloat(String(record.bonus || "0").replace(/[^0-9,\-]/g, '').replace(',', '.')) || 0;
                let sFin = parseFloat(String(record['s. fin.'] || "0").replace(/[^0-9,\-]/g, '').replace(',', '.')) || 0;

                let articoloCorrente = {
                    CODICE: "CSV-" + Math.floor(Math.random() * 10000000),
                    ARTICOLO: desc,
                    DESCRIZIONE: desc,
                    TIPO: "PZ",
                    IMPORTO: importoMerce,
                    QUANTITA: qta,
                    CATEGORIA: cat
                };

                let appartieneAStessaVendita = venditaCorrente &&
                    venditaCorrente.CLIENTE === cliente.toUpperCase() &&
                    venditaCorrente.GIORNO === dataExcel &&
                    venditaCorrente.ORA === ora &&
                    isMultipla;

                if (appartieneAStessaVendita) {
                    venditaCorrente.ARTICOLI.push(articoloCorrente);
                } else {
                    if (venditaCorrente) venditeDaSalvare.push(venditaCorrente);
                    venditaCorrente = {
                        CLIENTE: cliente.toUpperCase(), GIORNO: dataExcel, ORA: ora, CONTANTI: contanti, POS: pos, PUNTI_CARICATI: pCaric, PUNTI_SCARICATI: pScaric, BONUS: bonus, SALDO_PUNTI_INIZIALE: sIniz, SALDO_PUNTI_FINALE: sFin, ARTICOLI: [articoloCorrente]
                    };
                }
            }
        }

        if (categorieDaAggiungere.size > 0) {
            let catsAttuali = typeof getCategorieMagazzino === "function" ? getCategorieMagazzino() : ["PROFUMERIA", "COSMETICA", "MAKE-UP", "GADGET", "VARIE"];
            let setCats = new Set(catsAttuali);
            categorieDaAggiungere.forEach(c => setCats.add(c));

            if (typeof salvaCategorieMagazzino === "function") {
                salvaCategorieMagazzino(Array.from(setCats));
            }
            if (typeof popolaSelectCategorie === "function") {
                popolaSelectCategorie();
            }
        }

        if (tabella === 'vendite') {
            if (venditaCorrente) venditeDaSalvare.push(venditaCorrente);
            conteggioAggiunti = 0;
            let timeBase = Date.now();

            if (venditeDaSalvare.length > 0) {
                let tx = db.transaction('vendite', 'readwrite');
                let store = tx.objectStore('vendite');
                venditeDaSalvare.forEach((v, index) => {
                    if (!v.id) v.id = timeBase + index;
                    store.add(v);
                    if (typeof salvaVenditaCloud === "function") salvaVenditaCloud(v);
                });
                conteggioAggiunti += venditeDaSalvare.length;
            }

            if (movimentiDaSalvare.length > 0) {
                let txMov = db.transaction('movimenti_cassa', 'readwrite');
                let storeMov = txMov.objectStore('movimenti_cassa');
                let timeBaseMov = Date.now() + 500000;
                movimentiDaSalvare.forEach((m, index) => {
                    if (!m.id) m.id = timeBaseMov + index;
                    storeMov.add(m);
                    if (typeof salvaMovimentoCloud === "function") salvaMovimentoCloud(m);
                });
                conteggioAggiunti += movimentiDaSalvare.length;
            }
        }

        mostraAvvisoModale(`✅ Importazione completata!<br><br>Sono stati elaborati, salvati localmente e sincronizzati su Firebase <b>${conteggioAggiunti}</b> record nell'archivio ${tabella.toUpperCase()}.`);
        event.target.value = '';
    };

    reader.readAsText(file, 'UTF-8');
};

// 4.1. Salvataggio Impostazioni Personalizzate
const MSG_BASE_DEFAULT = "CHEMARIA FIDELITY\n\nCiao, {NOME}\n\nCard N: {SCHEDA}\n\n-------------------------\n* Saldo Iniziale: {SALDO_INIZIALE}\n\n* Punti Caricati: {PUNTI_CARICATI}\n\n* Punti Scaricati: {PUNTI_SCARICATI}\n\n* Saldo Punti: {PUNTI}\n\n* Bonus: € {BONUS}\n-------------------------\n\n{DATA}\n{ORA}";

window.caricaImpostazioniAvanzate = function () {
    // Carica PIN e Messaggio App
    let pinAttivo = localStorage.getItem('impostazioni_pin_attivo');
    document.getElementById('impostazioni-pin-toggle').checked = (pinAttivo !== 'false');

    let msgSalvato = localStorage.getItem('impostazioni_msg_template');
    if (!msgSalvato) msgSalvato = MSG_BASE_DEFAULT;
    document.getElementById('impostazioni-msg-template').value = msgSalvato;

    // Carica Dati Scontrino
    document.getElementById('imp-stampa-nome').value = localStorage.getItem('imp_stampa_nome') || "";
    document.getElementById('imp-stampa-indirizzo').value = localStorage.getItem('imp_stampa_indirizzo') || "";
    document.getElementById('imp-stampa-piva').value = localStorage.getItem('imp_stampa_piva') || "";
    document.getElementById('imp-stampa-footer').value = localStorage.getItem('imp_stampa_footer') || "Grazie e Arrivederci!";

    // Carica URL Firebase
    let urlFirebase = document.getElementById('impostazioni-firebase-url');
    if (urlFirebase) urlFirebase.value = FIREBASE_URL;

    // Carica Dati SumUp
    document.getElementById('impostazioni-sumup-id').value = localStorage.getItem('sumup_client_id') || "";
    document.getElementById('impostazioni-sumup-secret').value = localStorage.getItem('sumup_client_secret') || "";
};

window.salvaImpostazioniAvanzate = function () {
    // Salva PIN e Messaggio
    let pinAttivo = document.getElementById('impostazioni-pin-toggle').checked;
    let msg = document.getElementById('impostazioni-msg-template').value.trim();
    if (msg === "") msg = MSG_BASE_DEFAULT;

    localStorage.setItem('impostazioni_pin_attivo', pinAttivo ? 'true' : 'false');
    localStorage.setItem('impostazioni_msg_template', msg);

    // Salva Dati Scontrino
    localStorage.setItem('imp_stampa_nome', document.getElementById('imp-stampa-nome').value.trim());
    localStorage.setItem('imp_stampa_indirizzo', document.getElementById('imp-stampa-indirizzo').value.trim());
    localStorage.setItem('imp_stampa_piva', document.getElementById('imp-stampa-piva').value.trim());
    localStorage.setItem('imp_stampa_footer', document.getElementById('imp-stampa-footer').value.trim());

    // Salva Firebase URL
    let inputFirebase = document.getElementById('impostazioni-firebase-url');
    if (inputFirebase) {
        let nuovoUrl = inputFirebase.value.trim();
        if (nuovoUrl.endsWith("/")) nuovoUrl = nuovoUrl.slice(0, -1);
        localStorage.setItem('gestionale_firebase_url', nuovoUrl);
        FIREBASE_URL = nuovoUrl;
    }

    // Salva Dati SumUp
    localStorage.setItem('sumup_client_id', document.getElementById('impostazioni-sumup-id').value.trim());
    localStorage.setItem('sumup_client_secret', document.getElementById('impostazioni-sumup-secret').value.trim());

    // Usa rigorosamente la modale
    mostraAvvisoModale("Impostazioni salvate con successo!<br>Se hai modificato il database, ricarica la pagina.");
};

// ==========================================
// ✏️ LOGICA EDITOR AVANZATO MESSAGGI
// ==========================================
// 1. Apre l'editor caricando il testo attuale
window.apriEditorMessaggio = function () {
    let testoAttuale = document.getElementById('impostazioni-msg-template').value;
    let editor = document.getElementById('editor-messaggio-textarea');
    editor.value = testoAttuale;

    // 🔥 CHIUDE il template sottostante per pulizia visiva
    chiudiModale('modal-impostazioni-whatsapp');
    apriModale('modal-editor-messaggio');

    // Mette a fuoco la casella di testo
    setTimeout(() => {
        editor.focus();
        // Sposta il cursore alla fine del testo
        editor.selectionStart = editor.selectionEnd = editor.value.length;
    }, 100);
};

// 2. Inserimento intelligente della variabile alla posizione del cursore
window.inserisciVariabileMessaggio = function (variabile) {
    const editor = document.getElementById('editor-messaggio-textarea');

    // Ottieni la posizione attuale del cursore
    const inizio = editor.selectionStart;
    const fine = editor.selectionEnd;
    const testo = editor.value;

    // Incolla la variabile esattamente dove si trovava il cursore
    editor.value = testo.substring(0, inizio) + variabile + testo.substring(fine);

    // Ripristina il focus e sposta il cursore subito dopo la variabile appena inserita
    editor.focus();
    const nuovaPosizione = inizio + variabile.length;
    editor.selectionStart = editor.selectionEnd = nuovaPosizione;
};

// 3. Conferma le modifiche e aggiorna l'anteprima
window.confermaEditorMessaggio = function () {
    let nuovoTesto = document.getElementById('editor-messaggio-textarea').value;

    // Aggiorna la casella di anteprima nelle impostazioni
    document.getElementById('impostazioni-msg-template').value = nuovoTesto;

    // 🔥 Chiude l'editor e RIAPRE il template con il testo aggiornato!
    chiudiModale('modal-editor-messaggio');
    apriModale('modal-impostazioni-whatsapp');
};

window.apriImpostazioniWhatsApp = function () {
    let msgSalvato = localStorage.getItem('impostazioni_msg_template') || MSG_BASE_DEFAULT;
    document.getElementById('impostazioni-msg-template').value = msgSalvato;

    chiudiModale('modal-impostazioni-menu');
    apriModale('modal-impostazioni-whatsapp');
};

window.salvaImpostazioniWhatsApp = function () {
    let nuovoMsg = document.getElementById('impostazioni-msg-template').value;
    localStorage.setItem('impostazioni_msg_template', nuovoMsg);

    mostraAvvisoModale("Template WhatsApp aggiornato con successo!");
    chiudiModale('modal-impostazioni-whatsapp');
    apriModale('modal-impostazioni-menu');
};

// ==========================================
// 🔫 LOGICA LETTORE BARCODE GLOBALE (OMNIDIREZIONALE)
// ==========================================
let bufferScanner = "";
let ultimoTastoScanner = 0;

document.addEventListener('keypress', async function (e) {
    // 1. Controlla se siamo nella Cassa (il menu principale deve essere chiuso)
    let menuAperto = document.getElementById('modal-menu-principale').style.display !== 'none';
    if (menuAperto) return;

    // 2. Se l'utente sta scrivendo in un altro campo (es. ricerca cliente, calcolatrice), ignora lo scanner globale
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        return;
    }

    let tempoAttuale = Date.now();

    // 3. Se è passato troppo tempo (più di 50 millisecondi) dall'ultimo tasto, 
    // significa che è un umano che digita sulla tastiera, non uno scanner laser. Azzeriamo la memoria!
    if (tempoAttuale - ultimoTastoScanner > 50) {
        bufferScanner = "";
    }

    // 4. Se lo scanner invia "Enter" (Invio) alla fine del codice
    if (e.key === 'Enter') {
        if (bufferScanner.length > 3) {
            // Abbiamo un codice a barre valido! Lo cerchiamo in magazzino
            const magazzinoCompleto = await getAll('magazzino');
            const prodotto = magazzinoCompleto.find(p => p.codice === bufferScanner);

            if (prodotto) {
                aggiungiProdotto(prodotto);
            } else {
                mostraAvvisoModale(`<b>PRODOTTO SCONOSCIUTO</b><br>Nessun articolo trovato con il codice: ${bufferScanner}`);
            }
            bufferScanner = ""; // Svuota la memoria per il prossimo codice
        }
    } else {
        // Aggiunge la lettera o il numero alla memoria temporanea
        bufferScanner += e.key;
    }

    ultimoTastoScanner = tempoAttuale;
});

// ==========================================
// 🛡️ MODULO SICUREZZA, RUOLI E SYS_LOGS
// ==========================================

// 1. Matrice degli Utenti e Permessi
// 1. Matrice degli Utenti (Dinamica con Memoria)
let listaOperatori = JSON.parse(localStorage.getItem('gestionale_operatori_v2'));

// Se il gestionale è appena stato installato, crea gli account di base
if (!listaOperatori || listaOperatori.length === 0) {
    listaOperatori = [
        { id: 1, nome: "Admin", pin: "1234", ruolo: "ADMIN", max_sconto: 100 },
        { id: 2, nome: "Manager", pin: "5678", ruolo: "MANAGER", max_sconto: 15 },
        { id: 3, nome: "Commesso", pin: "0000", ruolo: "SALES", max_sconto: 5 }
    ];
    localStorage.setItem('gestionale_operatori_v2', JSON.stringify(listaOperatori));
}

// Forza il blocco cassa all'avvio in modo che venga letto il nuovo array
let operatoreLoggato = null;
let operatoreAttivo = "Nessuno";
let timerInattivita;

// 2. Registrazione Log di Sistema (Audit Trail)
window.registraLogSistema = async function (azione, dettagli) {
    let d = new Date();
    let log = {
        data: getOggiString(),
        ora: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`,
        operatore: operatoreLoggato ? operatoreLoggato.nome : "SISTEMA",
        ruolo: operatoreLoggato ? operatoreLoggato.ruolo : "SYS",
        azione: azione,
        dettagli: dettagli
    };

    try {
        let tx = db.transaction('sys_logs', 'readwrite');
        tx.objectStore('sys_logs').add(log);
    } catch (e) { console.error("Errore salvataggio SysLog", e); }
};

// 3. Sistema di Sblocco, Numpad Digitale e Fast-Switch
window.digitaPinSblocco = function (cifra) {
    let inputPin = document.getElementById('input-pin-sblocco');
    if (cifra === 'C') {
        inputPin.value = '';
    } else {
        if (inputPin.value.length < 4) {
            inputPin.value += cifra;
        }
    }

    inputPin.focus(); // Forza il cursore a restare sempre sulla casella

    if (inputPin.value.length === 4) {
        sbloccaCassaConPin(inputPin.value);
    }
};

window.sbloccaCassaConPin = function (pinInserito) {
    let utenteTrovato = listaOperatori.find(op => op.pin === pinInserito);

    if (!utenteTrovato) {
        mostraAvvisoModale("❌ PIN Errato. Riprova.");
        document.getElementById('input-pin-sblocco').value = "";
        return; // Il focus viene ricaricato dalla chiusura dell'avviso
    }

    operatoreLoggato = utenteTrovato;
    operatoreAttivo = utenteTrovato.nome;

    document.getElementById('label-operatore').innerHTML = `👤 ${utenteTrovato.nome} <span style="font-size:1.2vh; color:#888;">(${utenteTrovato.ruolo})</span>`;

    chiudiModale('modal-sblocco-cassa');
    document.getElementById('input-pin-sblocco').value = "";
    registraLogSistema("LOGIN", `Accesso effettuato al sistema.`);
    applicaRestrizioniUI();
    resetTimerInattivita();

    // Se l'app si è appena avviata, mostra subito la griglia dei menu
    if (appAppenaAvviata) {
        apriModale('modal-menu-principale');
        appAppenaAvviata = false;
    }
};

// 4. Applicazione Permessi (Granularità UI)
window.applicaRestrizioniUI = function () {
    if (!operatoreLoggato) return;

    let isSales = operatoreLoggato.ruolo === 'SALES';
    let isManager = operatoreLoggato.ruolo === 'MANAGER';

    // Nascondi prezzo acquisto in magazzino (Sales)
    let trPrezzoAcq = document.getElementById('mag-prezzo-acq');
    if (trPrezzoAcq && trPrezzoAcq.parentElement) trPrezzoAcq.parentElement.style.display = isSales ? 'none' : 'block';

    // Blocca modifica giacenza manuale in magazzino (solo Admin)
    let inputGiacenza = document.getElementById('mag-giacenza');
    if (inputGiacenza) inputGiacenza.readOnly = (isSales || isManager); // Manager fa scarichi ufficiali, non "trucca" i numeri

    // Nascondi Business Intelligence (Sales e Manager)
    let btnBI = document.getElementById('btn-statistiche');
    if (btnBI) btnBI.style.display = (isSales || isManager) ? 'none' : 'flex';
};

// 5. Blocco Cassa (Auto-Logout)
window.bloccaCassa = function () {
    if (operatoreLoggato) registraLogSistema("LOGOUT", `Disconnessione cassa.`);
    operatoreLoggato = null;
    operatoreAttivo = "Nessuno";
    document.getElementById('label-operatore').innerHTML = "🔒 BLOCCATO";
    document.getElementById('input-pin-sblocco').value = "";

    // Chiude tutti i menu e finestre aperte per non farle spiare
    document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
    apriModale('modal-sblocco-cassa');

    // 👇 Aumentato il ritardo a 300ms per dare tempo al browser di renderizzare e agganciare il focus in sicurezza
    setTimeout(() => {
        let input = document.getElementById('input-pin-sblocco');
        if (input) input.focus();
    }, 300);
};

window.resetTimerInattivita = function () {
    clearTimeout(timerInattivita);
    if (operatoreLoggato) {
        timerInattivita = setTimeout(bloccaCassa, 300000); // Auto-lock dopo 5 minuti
    }
};

['mousemove', 'keypress', 'click', 'touchstart'].forEach(evento => {
    document.body.addEventListener(evento, resetTimerInattivita);
});

// ==========================================
// 📊 MOTORE BUSINESS INTELLIGENCE (BI)
// ==========================================
let chartAndamentoInstance = null;
let chartCategorieInstance = null;
let datiGlobaliExportBI = {}; // Per l'esportazione Excel

window.calcolaStatistiche = async function () {
    const periodo = document.getElementById('stat-bi-periodo').value;

    // 1. Fetch Dati
    const vendite = await getAll('vendite');
    const magazzino = await getAll('magazzino');
    const clienti = await getAll('clienti');

    // Mappa Magazzino per Lookup veloce
    let magMap = {};
    let magValoreAcquisto = 0;
    let magValoreVendita = 0;
    magazzino.forEach(p => {
        magMap[p.codice] = p;
        if (p.giacenza > 0 && !p.is_kit && p.tipo !== 'VOUCHER') {
            magValoreAcquisto += (p.prezzoAcquisto * p.giacenza) || 0;
            magValoreVendita += (p.prezzo * p.giacenza) || 0;
        }
    });

    // 2. Filtro Date
    let oggi = new Date();
    let dataInizio = new Date(2000, 0, 1);
    let dataFine = new Date();

    let annoCorrente = oggi.getFullYear();
    let meseCorrente = oggi.getMonth();

    if (periodo === 'mese_corrente') { dataInizio = new Date(annoCorrente, meseCorrente, 1); }
    else if (periodo === 'mese_scorso') { dataInizio = new Date(annoCorrente, meseCorrente - 1, 1); dataFine = new Date(annoCorrente, meseCorrente, 0); }
    else if (periodo === 'anno_corrente') { dataInizio = new Date(annoCorrente, 0, 1); }

    let strInizio = dataInizio.toISOString().split('T')[0];
    let strFine = dataFine.toISOString().split('T')[0];

    // Variabili Accumulatori
    let kpi = { fatturato: 0, scontrini: 0, costoVenduto: 0, ivaTotale: 0 };
    let fatturatoAnnoPrec = 0;

    let mappaCategorie = {};
    let mappaProdotti = {};
    let mappaBrand = {};
    let mappaVenditeGiornaliere = {};

    // Costruisci dizionario giorni per il grafico a linee
    let currDate = new Date(dataInizio);
    while (currDate <= dataFine && periodo !== 'tutto') {
        mappaVenditeGiornaliere[currDate.toISOString().split('T')[0]] = 0;
        currDate.setDate(currDate.getDate() + 1);
    }

    // 3. Elaborazione Vendite
    vendite.forEach(v => {
        let isNelPeriodo = v.GIORNO >= strInizio && v.GIORNO <= strFine;

        // Calcolo Trend Anno Precedente
        let dataV = new Date(v.GIORNO);
        if (dataV.getFullYear() === annoCorrente - 1 && dataV.getMonth() === meseCorrente && periodo === 'mese_corrente') {
            fatturatoAnnoPrec += (v.CONTANTI + v.POS);
        }

        if (isNelPeriodo) {
            let totaleScontrino = v.CONTANTI + v.POS;
            kpi.fatturato += totaleScontrino;
            kpi.scontrini++;

            if (mappaVenditeGiornaliere[v.GIORNO] !== undefined) {
                mappaVenditeGiornaliere[v.GIORNO] += totaleScontrino;
            } else if (periodo === 'tutto') {
                let meseAnno = v.GIORNO.substring(0, 7); // Raggruppa per mese se "Tutto"
                if (!mappaVenditeGiornaliere[meseAnno]) mappaVenditeGiornaliere[meseAnno] = 0;
                mappaVenditeGiornaliere[meseAnno] += totaleScontrino;
            }

            v.ARTICOLI.forEach(art => {
                if (art.CODICE === "PUNTI" || art.IMPORTO <= 0) return;

                let imponibileRiga = art.IMPORTO / (1 + ((art.IVA || 22) / 100));
                kpi.ivaTotale += (art.IMPORTO - imponibileRiga);

                let prodottoDB = magMap[art.CODICE] || art;
                let costoAcquisto = (prodottoDB.prezzoAcquisto || 0) * art.QUANTITA;
                kpi.costoVenduto += costoAcquisto;

                // Stat Categorie
                let cat = art.CATEGORIA || "VARIE";
                if (!mappaCategorie[cat]) mappaCategorie[cat] = 0;
                mappaCategorie[cat] += art.IMPORTO;

                // Stat Prodotti
                if (!mappaProdotti[art.DESCRIZIONE]) mappaProdotti[art.DESCRIZIONE] = { qta: 0, val: 0 };
                mappaProdotti[art.DESCRIZIONE].qta += art.QUANTITA;
                mappaProdotti[art.DESCRIZIONE].val += art.IMPORTO;

                // Stat Brand
                let brand = prodottoDB.brand || "NESSUN BRAND";
                if (!mappaBrand[brand]) mappaBrand[brand] = 0;
                mappaBrand[brand] += art.IMPORTO;
            });
        }
    });

    // --- CALCOLO KPI ---
    let scontrinoMedio = kpi.scontrini > 0 ? kpi.fatturato / kpi.scontrini : 0;

    // Margine Reale = (Imponibile Netto - Costo Acquisto) / Imponibile Netto
    let imponibileNetto = kpi.fatturato - kpi.ivaTotale;
    let margineReale = imponibileNetto > 0 ? ((imponibileNetto - kpi.costoVenduto) / imponibileNetto) * 100 : 0;

    let trendTesto = "N/D";
    let trendColore = "#888";
    if (periodo === 'mese_corrente' && fatturatoAnnoPrec > 0) {
        let diffPerc = ((kpi.fatturato - fatturatoAnnoPrec) / fatturatoAnnoPrec) * 100;
        trendTesto = `vs Mese Prec. Anno: ${diffPerc > 0 ? '+' : ''}${diffPerc.toFixed(1)}%`;
        trendColore = diffPerc >= 0 ? "#00cc66" : "#ff4d4d";
    }

    // Rotazione Stock (Costo del Venduto / Valore Medio Magazzino) approssimato
    let rotazione = magValoreAcquisto > 0 ? (kpi.costoVenduto / magValoreAcquisto).toFixed(2) : "0";

    // --- STAMPA KPI A SCHERMO ---
    document.getElementById('bi-fatturato').textContent = `€ ${kpi.fatturato.toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;
    document.getElementById('bi-trend-fatturato').textContent = trendTesto;
    document.getElementById('bi-trend-fatturato').style.color = trendColore;

    document.getElementById('bi-scontrino-medio').textContent = `€ ${scontrinoMedio.toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;
    document.getElementById('bi-tot-scontrini').textContent = `${kpi.scontrini} transazioni`;

    document.getElementById('bi-margine').textContent = `${margineReale.toFixed(1)}%`;
    document.getElementById('bi-margine').style.color = margineReale < 30 ? "#ff4d4d" : "#00cc66";

    document.getElementById('bi-valore-magazzino').textContent = `€ ${magValoreAcquisto.toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;
    document.getElementById('bi-rotazione-stock').textContent = `Potenziale Vendita: € ${magValoreVendita.toLocaleString('it-IT', { minimumFractionDigits: 2 })} (Rot: ${rotazione})`;

    // --- CLASSIFICHE TOP ---
    let arrProdQta = Object.keys(mappaProdotti).map(k => ({ nome: k, qta: mappaProdotti[k].qta, val: mappaProdotti[k].val })).sort((a, b) => b.qta - a.qta).slice(0, 5);
    let arrBrand = Object.keys(mappaBrand).map(k => ({ nome: k, val: mappaBrand[k] })).sort((a, b) => b.val - a.val).slice(0, 3);

    let htmlTop = `<div style="color:#b3d9ff; font-size:1.2vh; margin-bottom:5px;">TOP 5 PER QUANTITÀ:</div>`;
    arrProdQta.forEach((p, i) => htmlTop += `<div style="display:flex; justify-content:space-between; border-bottom:1px solid #444; padding:2px 0;"><span>${i + 1}. ${p.nome}</span> <span style="color:#ffcc00;">${p.qta} pz</span></div>`);

    htmlTop += `<div style="color:#b3d9ff; font-size:1.2vh; margin-top:10px; margin-bottom:5px;">TOP 3 BRAND (VALORE):</div>`;
    arrBrand.forEach((b, i) => htmlTop += `<div style="display:flex; justify-content:space-between; border-bottom:1px solid #444; padding:2px 0;"><span>${i + 1}. ${b.nome}</span> <span style="color:#00ffcc;">€ ${b.val.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</span></div>`);

    document.getElementById('bi-top-prodotti').innerHTML = htmlTop || "Dati insufficienti";

    // --- DEAD STOCK (Fermi da >180gg) ---
    // Troviamo l'ultima data di vendita per ogni articolo
    let lastSaleDate = {};
    vendite.forEach(v => v.ARTICOLI.forEach(a => {
        if (!lastSaleDate[a.CODICE] || v.GIORNO > lastSaleDate[a.CODICE]) lastSaleDate[a.CODICE] = v.GIORNO;
    }));

    let htmlDead = "";
    let dataLimiteDS = new Date(); dataLimiteDS.setDate(dataLimiteDS.getDate() - 180);
    let strLimiteDS = dataLimiteDS.toISOString().split('T')[0];

    magazzino.filter(p => p.giacenza > 0 && !p.is_kit && p.tipo !== 'VOUCHER').forEach(p => {
        let ultimaV = lastSaleDate[p.codice];
        if (!ultimaV || ultimaV < strLimiteDS) {
            htmlDead += `<div style="display:flex; justify-content:space-between; border-bottom:1px solid #444; padding:3px 0;">
                <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; width:60%;" title="${p.descrizione}">${p.descrizione}</span>
                <span style="color:#888;">Giac: ${p.giacenza}</span>
                <span style="color:#ff4d4d; font-size:1.1vh;">${ultimaV ? ultimaV : 'Mai Venduto'}</span>
            </div>`;
        }
    });
    document.getElementById('bi-dead-stock').innerHTML = htmlDead || "<span style='color:#00cc66'>Nessun articolo fermo da oltre 6 mesi!</span>";

    // --- FIDELITY ---
    let clientiAcquisti = {};
    vendite.forEach(v => {
        if (v.CLIENTE !== "Nessuno") {
            if (!clientiAcquisti[v.CLIENTE]) clientiAcquisti[v.CLIENTE] = 0;
            clientiAcquisti[v.CLIENTE]++;
        }
    });

    let totClientiUnici = Object.keys(clientiAcquisti).length;
    let clientiTornati = Object.values(clientiAcquisti).filter(q => q > 1).length;
    let tassoRitorno = totClientiUnici > 0 ? (clientiTornati / totClientiUnici) * 100 : 0;

    document.getElementById('bi-tasso-ritorno').textContent = `${tassoRitorno.toFixed(1)}%`;
    document.getElementById('bi-tasso-ritorno').style.color = tassoRitorno >= 40 ? "#00cc66" : "#ffcc00";

    let htmlDormienti = "";
    let limitDormienti = new Date(); limitDormienti.setDate(limitDormienti.getDate() - 90);
    clienti.forEach(c => {
        if (c.dataUltimaOperazione) {
            let dataOp = new Date(c.dataUltimaOperazione);
            if (dataOp < limitDormienti) {
                let diffGiorni = Math.floor((oggi - dataOp) / (1000 * 60 * 60 * 24));
                htmlDormienti += `<div style="display:flex; justify-content:space-between; border-bottom:1px solid #444; padding:3px 0;">
                    <span>${c.nome}</span> <span style="color:#888;">${c.telefono}</span> <span style="color:#ffcc00;">Assente da ${diffGiorni}gg</span>
                </div>`;
            }
        }
    });
    document.getElementById('bi-clienti-dormienti').innerHTML = htmlDormienti || "Nessun cliente dormiente.";

    // --- RENDER GRAFICI CON CHART.JS ---
    renderGraficoAndamento(mappaVenditeGiornaliere);
    renderGraficoCategorie(mappaCategorie);

    // Salva i dati per esportazione Excel
    datiGlobaliExportBI = { kpi, arrProdQta, arrBrand, magValoreAcquisto, magValoreVendita };
};

// --- FUNZIONI GRAFICI ---
function renderGraficoAndamento(datiMap) {
    const ctx = document.getElementById('chart-andamento').getContext('2d');
    if (chartAndamentoInstance) chartAndamentoInstance.destroy(); // Distrugge il vecchio grafico se esiste

    let labels = Object.keys(datiMap).sort();
    let data = labels.map(k => datiMap[k]);

    // Formattazione etichette data
    let displayLabels = labels.map(l => {
        let p = l.split('-');
        return p.length === 3 ? `${p[2]}/${p[1]}` : `${p[1]}/${p[0]}`;
    });

    chartAndamentoInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: displayLabels,
            datasets: [{
                label: 'Fatturato €',
                data: data,
                borderColor: '#00ffcc',
                backgroundColor: 'rgba(0, 255, 204, 0.1)',
                borderWidth: 2,
                fill: true,
                tension: 0.3,
                pointRadius: 2
            }]
        },
        options: {
            maintainAspectRatio: false,
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { ticks: { color: '#888' }, grid: { color: '#333' } },
                x: { ticks: { color: '#888' }, grid: { display: false } }
            }
        }
    });
}

function renderGraficoCategorie(datiMap) {
    const ctx = document.getElementById('chart-categorie').getContext('2d');
    if (chartCategorieInstance) chartCategorieInstance.destroy();

    let labels = Object.keys(datiMap);
    let data = labels.map(k => datiMap[k]);

    chartCategorieInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: data,
                backgroundColor: ['#00ffcc', '#4d88ff', '#ffcc00', '#ff4d4d', '#9933ff', '#ff9933'],
                borderWidth: 0
            }]
        },
        options: {
            maintainAspectRatio: false,
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: 'right', labels: { color: '#fff', font: { size: 10 } } }
            }
        }
    });
}

// --- FUNZIONI ESPORTAZIONE BI ---
window.stampaDashboardPDF = function () {
    let oldTitle = document.title;
    document.title = "Report_Business_Intelligence_" + new Date().toISOString().split('T')[0];

    // Inietto uno stile temporaneo per la stampa ottimizzata
    let st = document.createElement('style');
    st.innerHTML = `
        @media print {
            body * { visibility: hidden; }
            #area-stampa-bi, #area-stampa-bi * { visibility: visible; }
            #area-stampa-bi { position: absolute; left: 0; top: 0; width: 100%; color: black !important; background: white !important;}
            .modal-box { border: none !important; background: white !important; }
            canvas { max-width: 100% !important; height: auto !important; }
            div { color: black !important; }
            span { color: black !important; }
        }
    `;
    document.head.appendChild(st);

    window.print();

    document.head.removeChild(st);
    document.title = oldTitle;
};

window.esportaDashboardCSV = function () {
    let csv = "BUSINESS INTELLIGENCE REPORT\n\n";
    csv += `Fatturato Totale;${datiGlobaliExportBI.kpi.fatturato.toFixed(2).replace('.', ',')}\n`;
    csv += `Numero Scontrini;${datiGlobaliExportBI.kpi.scontrini}\n`;
    csv += `Costo del Venduto;${datiGlobaliExportBI.kpi.costoVenduto.toFixed(2).replace('.', ',')}\n`;
    csv += `Valore Magazzino (Acquisto);${datiGlobaliExportBI.magValoreAcquisto.toFixed(2).replace('.', ',')}\n\n`;

    csv += "TOP PRODOTTI (QTA)\nNome;Qta Venduta;Incasso\n";
    datiGlobaliExportBI.arrProdQta.forEach(p => {
        csv += `"${p.nome}";${p.qta};${p.val.toFixed(2).replace('.', ',')}\n`;
    });

    let encodedUri = encodeURI("data:text/csv;charset=utf-8," + csv);
    let link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `Export_BI_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};

// ==========================================
// 📡 TRASMISSIONE LIVE AL CRUSCOTTO REMOTO (VERSIONE COMPLETA)
// ==========================================
window.inviaVenditaLive = async function (record) {
    if (!navigator.onLine) return;

    let payload = {
        id: record.id,
        ora: record.ORA,
        operatore: record.OPERATORE || "Sconosciuto",
        totale: record.CONTANTI + record.POS,
        contanti: record.CONTANTI,
        pos: record.POS,
        tipo: "VENDITA" // Aggiunta etichetta per il cruscotto
    };

    const url = `${FIREBASE_URL}/vendite_live/${record.GIORNO}/${record.id}.json`;
    try { await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); } catch (e) { }
};

window.inviaMovimentoLive = async function (movimento) {
    if (!navigator.onLine) return;

    let payload = {
        id: "MOV_" + movimento.id,
        ora: movimento.ora,
        operatore: operatoreAttivo || "Sconosciuto",
        totale: movimento.importo,
        tipo: movimento.tipo, // 'ENTRATA' o 'USCITA'
        descrizione: movimento.descrizione
    };

    const url = `${FIREBASE_URL}/vendite_live/${movimento.data}/MOV_${movimento.id}.json`;
    try { await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); } catch (e) { }
};

// Aggancio la rimozione del movimento dal Cloud nel sistema universale
let f_eseguiEliminazioneUniversale = window.eseguiEliminazioneUniversale;
window.eseguiEliminazioneUniversale = async function () {
    if (tipoEliminazione === 'MOVIMENTO') {
        let mov = await getRecordById('movimenti_cassa', idDaEliminare);
        await deleteRecord('movimenti_cassa', idDaEliminare);

        // 🔥 Rimuovi dal cruscotto Cloud e dal Backup
        if (mov && navigator.onLine) {
            fetch(`${FIREBASE_URL}/vendite_live/${mov.data}/MOV_${idDaEliminare}.json`, { method: 'DELETE' }).catch(e => console.log(e));
            fetch(`${FIREBASE_URL}/storico_movimenti/${idDaEliminare}.json`, { method: 'DELETE' }).catch(e => console.log(e));
        }

        await popolaRegistroCassa();
        chiudiModale('modal-conferma-elimina');
        mostraMessaggio("MOVIMENTO ELIMINATO CON SUCCESSO");
    } else {
        f_eseguiEliminazioneUniversale(); // Chiama la vecchia funzione per Clienti, Prodotti e Scontrini
    }
};

window.eliminaVenditaLive = async function (giorno, idVendita) {
    if (!navigator.onLine) return;

    // Indirizzo del dato da eliminare
    const url = `${FIREBASE_URL}/vendite_live/${giorno}/${idVendita}.json`;

    try {
        // Usiamo DELETE per rimuovere fisicamente il nodo
        let response = await fetch(url, {
            method: 'DELETE'
        });

        if (response.ok) {
            console.log(`✅ ELIMINAZIONE FIREBASE RIUSCITA: Incasso stornato dal cloud!`);
        } else {
            console.error("❌ ERRORE FIREBASE HTTP:", response.status);
        }
    } catch (e) {
        console.error("❌ ERRORE FIREBASE (Eliminazione fallita):", e);
    }
};

// ==========================================
// ☁️ CLOUD-SYNC: MOTORE BIDIREZIONALE CLIENTI
// ==========================================

// 1. SPINGE il cliente sul Cloud (quando lo crei o lo modifichi)
window.salvaClienteCloud = async function (cliente) {
    if (!navigator.onLine) return;

    // Scudo Anti-Orfani
    if (!cliente || !cliente.scheda || cliente.scheda.trim() === '') return;

    cliente.timestamp_sync = Date.now();

    // 🔥 FIX FONDAMENTALE (Salvataggio Chat): 
    // Creiamo una copia esatta del cliente ma "scolleghiamo" la cartella messaggi prima di inviarla.
    // In questo modo il PATCH aggiornerà nome, punti e notifiche, lasciando intatta la cronologia chat su Firebase!
    let payloadDaInviare = { ...cliente };
    delete payloadDaInviare.messaggi;

    const url = `${FIREBASE_URL}/clienti/${cliente.scheda}.json`;

    try {
        await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payloadDaInviare) // Inviamo il payload pulito
        });
        console.log(`☁️ Sync UP: Cliente ${cliente.nome} aggiornato sul cloud.`);
    } catch (e) {
        console.error("Errore salvataggio cloud cliente:", e);
    }
};

// 2. TIRA GIÙ i clienti dal Cloud (all'avvio e in background)
window.scaricaClientiDalCloud = async function () {
    if (!navigator.onLine) return;

    const url = `${FIREBASE_URL}/clienti.json`;

    try {
        let response = await fetch(url);
        let clientiCloud = await response.json();

        if (clientiCloud) {
            let dbClientiLocali = await getAll('clienti');
            let tx = db.transaction('clienti', 'readwrite');
            let store = tx.objectStore('clienti');
            let aggiornamentiFatti = 0;

            // Confrontiamo il Cloud con il Locale
            Object.keys(clientiCloud).forEach(numeroScheda => {
                let clienteCloud = clientiCloud[numeroScheda];

                // 🌟 FIX FONDAMENTALE: Ignora i vecchi dati parziali di Firebase
                // Se il record non ha il numero di scheda o il nome, è un vecchio residuo e lo saltiamo!
                if (!clienteCloud || !clienteCloud.scheda || !clienteCloud.nome) {
                    return;
                }

                // 1. PRIMA DI TUTTO definiamo il clienteLocale (CERCA NEL DB LOCALE)
                let clienteLocale = dbClientiLocali.find(c => c.scheda === clienteCloud.scheda);
                let chatNotificata = false;

                // 2. ORA controlliamo la chat (perché clienteLocale adesso esiste!)
                if (clienteCloud.messaggi) {
                    let messaggiArray = Object.values(clienteCloud.messaggi);
                    let nuoviMessaggi = messaggiArray.filter(m =>
                        m.tipo === 'chat' &&
                        m.mittente === 'cliente' &&
                        m.timestamp > (clienteLocale?.ultima_lettura_chat || 0)
                    );

                    if (nuoviMessaggi.length > 0) {
                        // Prepariamo il nome in modo sicuro per evitare errori se contiene apostrofi (es. D'Amico)
                        let nomeSicuro = clienteCloud.nome.replace(/'/g, "\\'");

                        // Disegniamo la notifica con il nuovo super-bottone integrato
                        mostraAvvisoModale(`
                            🔔 Hai <b>${nuoviMessaggi.length}</b> nuovo/i messaggio/i in chat da:<br><br>
                            <span style="font-size: 2.5vh; color: #ff3366;"><b>${clienteCloud.nome}</b></span><br><br>
                            <button class="btn-modal" style="background-color: #ff3366; border: none; border-radius: 5px; color: white; width: 100%; margin-top: 15px; padding: 12px; font-weight: bold; font-size: 2vh; cursor: pointer;" onclick="apriChatDiretta('${clienteCloud.scheda}', '${nomeSicuro}')">💬 RISPONDI ORA</button>
                        `);

                        // Segniamo che abbiamo mostrato la notifica
                        if (clienteLocale) {
                            clienteLocale.ultima_lettura_chat = Date.now();
                            chatNotificata = true;
                        }
                    }
                }

                // 3. REGOLA D'ORO: Se non esiste in locale, o se quello sul cloud ha un timbro orario PIÙ RECENTE, scaricalo e sovrascrivi!
                let nonEsiste = !clienteLocale;
                let cloudPiuRecente = clienteLocale && clienteCloud.timestamp_sync && (!clienteLocale.timestamp_sync || clienteCloud.timestamp_sync > clienteLocale.timestamp_sync);

                if (nonEsiste || cloudPiuRecente) {
                    // Se stiamo sovrascrivendo con il cloud, conserviamo il timbro di lettura appena messo!
                    if (chatNotificata) clienteCloud.ultima_lettura_chat = clienteLocale.ultima_lettura_chat;
                    store.put(clienteCloud);
                    aggiornamentiFatti++;
                } else if (chatNotificata) {
                    // Se non ci sono altri dati da aggiornare dal cloud, ma abbiamo solo mostrato la notifica, salviamo la lettura locale.
                    store.put(clienteLocale);
                    aggiornamentiFatti++;
                }
            });

            if (aggiornamentiFatti > 0) {
                console.log(`☁️ Sync DOWN: Scaricati e aggiornati ${aggiornamentiFatti} clienti dal cloud.`);
                // Aggiorna la tabella a schermo se l'utente ha la modale aperta (nessun alert di sistema)
                if (document.getElementById('modal-gestione-clienti').style.display !== 'none') {
                    crmCaricaLista();
                }
            }
        }
    } catch (e) {
        console.error("Errore download cloud clienti:", e);
    }
};

// ==========================================
// ☁️ CLOUD-SYNC: MOTORE BIDIREZIONALE MAGAZZINO
// ==========================================

// 1. SPINGE il prodotto sul Cloud (Creazione / Modifica)
window.salvaProdottoCloud = async function (prodotto) {
    if (!navigator.onLine) return;

    prodotto.timestamp_sync = Date.now(); // Timbro orario
    const url = `${FIREBASE_URL}/magazzino/${prodotto.codice}.json`;

    try {
        await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(prodotto)
        });
        console.log(`☁️ Sync UP: Prodotto [${prodotto.codice}] inviato al cloud.`);
    } catch (e) {
        console.error("Errore salvataggio cloud prodotto:", e);
    }
};

// 2. TIRA GIÙ i prodotti dal Cloud
window.scaricaMagazzinoDalCloud = async function () {
    if (!navigator.onLine) return;

    const url = `${FIREBASE_URL}/magazzino.json`;

    try {
        let response = await fetch(url);
        let magazzinoCloud = await response.json();

        if (magazzinoCloud) {
            let dbMagazzinoLocale = await getAll('magazzino');
            let tx = db.transaction('magazzino', 'readwrite');
            let store = tx.objectStore('magazzino');
            let aggiornamentiFatti = 0;

            Object.keys(magazzinoCloud).forEach(codice => {
                let prodCloud = magazzinoCloud[codice];

                // Ignora dati corrotti
                if (!prodCloud || !prodCloud.codice || !prodCloud.descrizione) return;

                let prodLocale = dbMagazzinoLocale.find(p => p.codice === prodCloud.codice);

                let nonEsiste = !prodLocale;
                let cloudPiuRecente = prodLocale && prodCloud.timestamp_sync && (!prodLocale.timestamp_sync || prodCloud.timestamp_sync > prodLocale.timestamp_sync);

                if (nonEsiste || cloudPiuRecente) {
                    store.put(prodCloud);
                    aggiornamentiFatti++;
                }
            });

            if (aggiornamentiFatti > 0) {
                console.log(`☁️ Sync DOWN: Scaricati e aggiornati ${aggiornamentiFatti} prodotti dal cloud.`);
                // Aggiorna la UI se siamo nella schermata Magazzino
                if (document.getElementById('modal-magazzino').style.display !== 'none') {
                    magCaricaLista();
                }
            }
        }
    } catch (e) {
        console.error("Errore download cloud magazzino:", e);
    }
};

// ==========================================
// 📱 1. GENERAZIONE vCARD (QR CODE)
// ==========================================
window.generaQRvCard = function() {
    let nomeCompleto = document.getElementById('crm-nome').value.trim();
    let telefono = document.getElementById('crm-telefono').value.trim();

    if (nomeCompleto === '' || telefono === '') {
        mostraAvvisoModale("Per generare il QR Code devi prima inserire il Nome e il Telefono.");
        return;
    }

    let parti = nomeCompleto.split(' ');
    let nome = parti[0];
    let cognome = parti.length > 1 ? parti.slice(1).join(' ') : "";

    let vcard = `BEGIN:VCARD\nVERSION:3.0\nN:${cognome};${nome};;;\nFN:${nomeCompleto}\nTEL;TYPE=CELL:${telefono}\nEND:VCARD`;
    let url = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(vcard)}`;

    document.getElementById('qr-nome-cliente').textContent = nomeCompleto;
    document.getElementById('qr-tel-cliente').textContent = telefono;
            
    let img = document.getElementById('img-qr-vcard');
    let loader = document.getElementById('qr-loading');
            
    img.style.display = 'none';
    loader.style.display = 'block';
    img.onload = function() { loader.style.display = 'none'; img.style.display = 'block'; };
    img.src = url;

    apriModale('modal-qr-vcard');
};

// ==========================================
// 📲 2. INVIA CONTATTO AL PROPRIO WHATSAPP
// ==========================================
window.inviaContattoAlMioWhatsApp = function() {
    let nomeCompleto = document.getElementById('crm-nome').value.trim();
    let telefono = document.getElementById('crm-telefono').value.trim();

    if (nomeCompleto === '' || telefono === '') {
        mostraAvvisoModale("Per inviarti il contatto devi prima inserire il Nome e il Telefono.");
        return;
    }

    // 🛑 INSERISCI QUI IL TUO NUMERO DI TELEFONO PERSONALE (lascia il 39 davanti)
    let ilMioNumero = "393802837220"; 

    let messaggio = `👤 *Nuovo Contatto da Salvare*\nNome: ${nomeCompleto}\nTel: ${telefono}`;
    let url = `whatsapp://send?phone=${ilMioNumero}&text=${encodeURIComponent(messaggio)}`;
    window.open(url, '_blank');
};

// ==========================================
// 💬 3. APERTURA CHAT WHATSAPP DIRETTA CLIENTE
// ==========================================
window.apriWhatsAppDiretto = function() {
    let telefono = document.getElementById('crm-telefono').value.trim();
            
    if (telefono === '') {
        mostraAvvisoModale("Inserisci il numero di telefono per aprire WhatsApp.");
        return;
    }

    let numeroPulito = telefono.replace(/[^0-9]/g, '');
    if (!numeroPulito.startsWith('39') && numeroPulito.length <= 10) {
        numeroPulito = '39' + numeroPulito;
    }

    window.open(`whatsapp://send?phone=${numeroPulito}`, '_blank');
};

// ==========================================
// 💬 CHAT BIDIREZIONALE APP FIDELITY
// ==========================================
let chatClienteAttuale = null;
let chatSyncTimer = null;             // Timer per il controllo veloce
let numeroMessaggiInSchermo = 0;      // Contatore messaggi per evitare sfarfallii

window.apriSchermataChat = async function () {
    let scheda = document.getElementById('crm-codice').value.trim();
    let nome = document.getElementById('crm-nome').value.trim();

    if (!scheda) {
        mostraAvvisoModale("Seleziona o salva prima un cliente per aprire la chat.");
        return;
    }

    chatClienteAttuale = await getRecordById('clienti', scheda);
    if (!chatClienteAttuale) { chatClienteAttuale = { scheda: scheda, nome: nome }; }

    document.getElementById('chat-titolo').textContent = `💬 CHAT: ${nome}`;
    document.getElementById('chat-input-testo').value = '';

    apriModale('modal-chat-app');
    await ridisegnaTimelineChat();

    chatClienteAttuale.ultima_lettura_chat = Date.now();
    if (chatClienteAttuale.telefono) await updateCliente(chatClienteAttuale);

    // 🔥 Avvia il motore turbo per ricevere le risposte in tempo reale!
    avviaSyncChatVeloce();
};

// Funzione per chiudere e spegnere il turbo
window.chiudiSchermataChat = function () {
    if (chatSyncTimer) clearInterval(chatSyncTimer); // Spegne il motore
    chiudiModale('modal-chat-app');
};

window.ridisegnaTimelineChat = async function () {
    let timeline = document.getElementById('chat-timeline');

    // Mettiamo il caricamento solo se è la primissima apertura (schermo vuoto)
    if (timeline.innerHTML === '') {
        timeline.innerHTML = '<div style="text-align:center; color:#888; padding:20px;">Caricamento...</div>';
    }

    if (!navigator.onLine) {
        timeline.innerHTML = '<div style="text-align:center; color:#ff4d4d; padding:20px;">Sei offline. Impossibile caricare la chat.</div>';
        return;
    }

    try {
        let url = `${FIREBASE_URL}/clienti/${chatClienteAttuale.scheda}/messaggi.json`;
        let response = await fetch(url);
        let dati = await response.json();

        if (!dati) {
            timeline.innerHTML = '<div style="text-align:center; color:#888; padding:20px;">Nessun messaggio in cronologia. Inizia la conversazione!</div>';
            numeroMessaggiInSchermo = 0;
            return;
        }

        let messaggi = Object.values(dati).filter(m => m.tipo === 'chat');
        messaggi.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

        numeroMessaggiInSchermo = messaggi.length; // Aggiorna il contatore

        if (messaggi.length === 0) {
            timeline.innerHTML = '<div style="text-align:center; color:#888; padding:20px;">Nessun messaggio in cronologia. Inizia la conversazione!</div>';
            return;
        }

        timeline.innerHTML = ''; // Svuota la griglia per inserire i nuovi fumetti

        messaggi.forEach(m => {
            let div = document.createElement('div');
            let isNegozio = m.mittente === 'negozio';

            div.style.maxWidth = '80%';
            div.style.padding = '8px 12px';
            div.style.borderRadius = '12px';
            div.style.fontSize = '1.6vh';
            div.style.lineHeight = '1.4';
            div.style.position = 'relative';
            div.style.wordWrap = 'break-word';

            if (isNegozio) {
                div.style.alignSelf = 'flex-end';
                div.style.backgroundColor = '#0055cc';
                div.style.color = '#ffffff';
                div.style.borderBottomRightRadius = '2px';
            } else {
                div.style.alignSelf = 'flex-start';
                div.style.backgroundColor = '#334455';
                div.style.color = '#ffffff';
                div.style.borderBottomLeftRadius = '2px';
            }

            // --- NOVITÀ: GESTIONE IMMAGINI IN ENTRATA ---
            let testoVisualizzato = m.testo;

            // Se Firebase ci dice che c'è un link immagine, creiamo il tag <img>
            if (m.immagineUrl) {
                testoVisualizzato = `<img src="${m.immagineUrl}" style="max-width: 100%; max-height: 250px; border-radius: 8px; margin-bottom: 5px; cursor: pointer; border: 1px solid #444;" onclick="window.open('${m.immagineUrl}', '_blank')" title="Clicca per ingrandire"><br>${m.testo !== "📷 Immagine" ? m.testo : ""}`;
            }

            div.innerHTML = `
                        <div style="font-weight:bold; font-size:1.2vh; color: ${isNegozio ? '#99ccff' : '#00ffcc'}; margin-bottom: 3px;">
                            ${isNegozio ? 'Tu' : 'Cliente'} <span style="font-weight:normal; color:#aaa;">- ${m.data} ${m.ora}</span>
                        </div>
                        <div>${testoVisualizzato}</div>
                    `;
            // --------------------------------------------
            timeline.appendChild(div);
        });

        // Scorri in fondo automaticamente
        timeline.scrollTop = timeline.scrollHeight;

    } catch (e) {
        timeline.innerHTML = '<div style="text-align:center; color:#ff4d4d; padding:20px;">Errore di connessione.</div>';
    }
};

// ==========================================
// 🚀 SCORCIATOIA: APRI CHAT DA NOTIFICA
// ==========================================
window.apriChatDiretta = function (scheda, nome) {
    // 1. Chiude tutte le modali aperte (incluso l'avviso del messaggio)
    document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');

    // 2. Precompila silenziosamente i campi del CRM necessari alla chat
    document.getElementById('crm-codice').value = scheda;
    document.getElementById('crm-nome').value = nome;

    // 3. Lancia istantaneamente l'interfaccia della chat
    apriSchermataChat();
};

// 🔥 IL MOTORE TURBO: Controlla in background ogni 3 secondi
window.avviaSyncChatVeloce = function () {
    if (chatSyncTimer) clearInterval(chatSyncTimer);

    chatSyncTimer = setInterval(async () => {
        let modal = document.getElementById('modal-chat-app');

        // Sicurezza assoluta: se la finestra viene chiusa o nascosta, il motore si spegne da solo
        if (!modal || modal.style.display === 'none' || modal.style.display === '') {
            clearInterval(chatSyncTimer);
            return;
        }

        if (!navigator.onLine || !chatClienteAttuale) return;

        try {
            // Controlla il Cloud senza far lampeggiare lo schermo
            let url = `${FIREBASE_URL}/clienti/${chatClienteAttuale.scheda}/messaggi.json`;
            let response = await fetch(url);
            let dati = await response.json();

            if (dati) {
                let messaggi = Object.values(dati).filter(m => m.tipo === 'chat');

                // C'è un nuovo messaggio che non abbiamo ancora disegnato?
                if (messaggi.length !== numeroMessaggiInSchermo) {
                    await ridisegnaTimelineChat();

                    // Aggiorna la lettura in locale per evitare che la notifica generale suoni per questo messaggio
                    chatClienteAttuale.ultima_lettura_chat = Date.now();
                    if (chatClienteAttuale.telefono) await updateCliente(chatClienteAttuale);
                }
            }
        } catch (e) { } // Ignora gli errori di connessione temporanei

    }, 3000); // 3000 millisecondi = 3 secondi (Puoi alzarlo o abbassarlo a piacimento)
};

window.inviaMessaggioChatApp = async function () {
    let input = document.getElementById('chat-input-testo');
    let testo = input.value.trim();

    if (!testo || !chatClienteAttuale) return;

    input.disabled = true; // Blocca input durante l'invio

    let url = `${FIREBASE_URL}/clienti/${chatClienteAttuale.scheda}/messaggi.json`;
    let oggi = new Date();

    // Il Payload esatto richiesto dall'App
    let payload = {
        tipo: "chat",
        mittente: "negozio",
        testo: testo,
        data: `${String(oggi.getDate()).padStart(2, '0')}/${String(oggi.getMonth() + 1).padStart(2, '0')}/${oggi.getFullYear()}`,
        ora: `${String(oggi.getHours()).padStart(2, '0')}:${String(oggi.getMinutes()).padStart(2, '0')}`,
        timestamp: Date.now()
    };

    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        input.value = ''; // Pulisci testo
        await ridisegnaTimelineChat(); // Ricarica cronologia per vedere il nuovo messaggio

    } catch (e) {
        mostraAvvisoModale("Errore di connessione. Messaggio non inviato.");
    }

    input.disabled = false;
    input.focus();
};

// ==========================================
// ☁️ CLOUD-SYNC: STORICO VENDITE E MOVIMENTI (BACKUP TOTALE)
// ==========================================
function salvaVendita(recordVendita) {
    return new Promise((resolve) => {
        // --- NOVITÀ: Genera un ID temporale indistruttibile se manca ---
        if (!recordVendita.id) recordVendita.id = Date.now();
        // ---------------------------------------------------------------

        let tx = db.transaction('vendite', 'readwrite');
        tx.objectStore('vendite').put(recordVendita); // 🚀 Evita duplicati in caso di ripristino
        tx.oncomplete = () => {
            if (typeof salvaVenditaCloud === "function") salvaVenditaCloud(recordVendita); // 🚀 Push al Cloud
            resolve();
        };
    });
}

window.salvaMovimentoCloud = async function (movimento) {
    if (!navigator.onLine || !FIREBASE_URL) return;
    const url = `${FIREBASE_URL}/storico_movimenti/${movimento.id}.json`;
    try { await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(movimento) }); } catch (e) { }
};

window.scaricaVenditeDalCloud = async function () {
    if (!navigator.onLine || !FIREBASE_URL) return;
    try {
        let res = await fetch(`${FIREBASE_URL}/storico_vendite.json`);
        let dati = await res.json();
        if (dati) {
            let tx = db.transaction('vendite', 'readwrite');
            let store = tx.objectStore('vendite');
            Object.values(dati).forEach(v => store.put(v));
        }
    } catch (e) { }
};

window.scaricaMovimentiDalCloud = async function () {
    if (!navigator.onLine || !FIREBASE_URL) return;
    try {
        let res = await fetch(`${FIREBASE_URL}/storico_movimenti.json`);
        let dati = await res.json();
        if (dati) {
            let tx = db.transaction('movimenti_cassa', 'readwrite');
            let store = tx.objectStore('movimenti_cassa');
            Object.values(dati).forEach(m => store.put(m));
        }
    } catch (e) { }
};

// --- FUNZIONE PRELIEVO TESTER / USO INTERNO ---
window.convertiUnitaInTester = async function () {
    let codice = document.getElementById('mag-codice').value.trim();
    let giacenzaInput = document.getElementById('mag-giacenza');
    let giacenza = parseInt(giacenzaInput.value) || 0;
    let costo = parseFloat(document.getElementById('mag-prezzo-acq').value.replace(',', '.')) || 0;
    let descrizione = document.getElementById('mag-descrizione').value.trim();

    if (!codice || document.getElementById('mag-codice').disabled === false) {
        mostraAvvisoModale("Devi prima salvare l'articolo nel magazzino prima di poterne prelevare un'unità.");
        return;
    }

    if (giacenza <= 0) {
        mostraAvvisoModale("Giacenza insufficiente.<br>Impossibile prelevare un'unità da convertire in tester.");
        return;
    }

    // 1. Decrementa la giacenza nell'input
    giacenzaInput.value = giacenza - 1;

    // 2. Forza il flag tester per bloccarlo in cassa
    document.getElementById('mag-is-tester').checked = true;

    // 3. Salva l'articolo per confermare il calo stock
    await magSalvaProdotto();

    // 4. Scrivi nel registro movimenti il costo "perso"
    try {
        let txMov = db.transaction('movimenti', 'readwrite');
        let storeMov = txMov.objectStore('movimenti');

        let recordMovimento = {
            data: new Date().toISOString(),
            tipo: "USCITA",
            categoria: "USO INTERNO / TESTER",
            descrizione: "Apertura Tester: " + descrizione + " [" + codice + "]",
            importo: costo,
            metodo: "Magazzino"
        };

        storeMov.add(recordMovimento);

        txMov.oncomplete = () => {
            mostraAvvisoModale(`<b>OPERAZIONE COMPLETATA</b><br><br>Un'unità è stata scalata dal magazzino.<br><br>È stata generata un'uscita nel registro movimenti in "Uso Interno" per <b>€ ${costo.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</b> (Costo d'acquisto) per mantenere allineato il calcolo degli utili.`);
        };
    } catch (e) {
        console.error("Errore salvataggio movimento uso interno:", e);
    }
};

// --- MODULO STAMPA ETICHETTE ---
let codaStampa = [];

window.apriCodaStampaDaMagazzino = async function () {
    let codice = document.getElementById('mag-codice').value.trim();
    if (!codice || document.getElementById('mag-codice').disabled === false) {
        mostraAvvisoModale("Salva o seleziona prima un articolo per stamparne l'etichetta.");
        return;
    }

    let p = await getProdottoDaMagazzino(codice);
    let lottoDaStampare = "N/D";

    // Ereditarietà: cerca il lotto attivo della Materia Prima (Liquido)
    if (p.is_kit && p.componenti_kit) {
        for (let c of p.componenti_kit) {
            let compDB = await getProdottoDaMagazzino(c.codice);
            // Identifica il liquido tramite il formato 'ml'
            if (compDB && compDB.formato === 'ml' && compDB.lotti) {
                let lottoAttivo = compDB.lotti.find(l => l.qta_residua > 0);
                if (lottoAttivo) lottoDaStampare = lottoAttivo.codice_lotto;
            }
        }
    } else if (p.lotti) {
        // Se è un articolo semplice, prende il suo lotto diretto
        let lottoAttivo = p.lotti.find(l => l.qta_residua > 0);
        if (lottoAttivo) lottoDaStampare = lottoAttivo.codice_lotto;
    }

    let qtaGiacenza = parseInt(document.getElementById('mag-giacenza').value) || 1;

    let articolo = {
        codice: codice,
        brand: document.getElementById('mag-brand').value.trim() || 'N/A',
        descrizione: document.getElementById('mag-descrizione').value.trim(),
        formato: document.getElementById('mag-formato').value.trim(),
        prezzo: parseFloat(document.getElementById('mag-prezzo-ven').value.replace(',', '.')) || 0,
        prezzo_promo: parseFloat(document.getElementById('mag-prezzo-promo').value.replace(',', '.')) || 0,
        lotto_stampato: lottoDaStampare // Variabile ereditata
    };

    aggiungiACodaStampa(articolo, qtaGiacenza);
    apriModale('modal-stampa-etichette');
    aggiornaUIStampa();
};

window.aggiungiACodaStampa = function (articolo, qta) {
    let esistente = codaStampa.find(i => i.codice === articolo.codice);
    if (esistente) esistente.qta += qta;
    else codaStampa.push({ ...articolo, qta: qta });
};

window.aggiornaQtaStampa = function (index, qta) {
    if (qta < 1) { codaStampa.splice(index, 1); }
    else { codaStampa[index].qta = parseInt(qta); }
    aggiornaUIStampa();
};

window.svuotaCodaStampa = function () {
    codaStampa = [];
    aggiornaUIStampa();
};

function aggiornaUIStampa() {
    let container = document.getElementById('lista-coda-stampa');
    container.innerHTML = '';

    if (codaStampa.length === 0) {
        container.innerHTML = '<div style="color: #888; text-align: center; padding: 20px;">Coda vuota.</div>';
    } else {
        codaStampa.forEach((item, index) => {
            let row = document.createElement('div');
            row.className = 'etichetta-item-coda';
            row.innerHTML = `
                <div style="color: #fff; font-size: 1.4vh; flex: 2;"><b>${item.brand}</b><br>${item.descrizione}</div>
                <div style="flex: 1; text-align: right; display:flex; align-items:center; gap:5px;">
                    <span style="color: #b3d9ff; font-size: 1.2vh;">Copie:</span>
                    <input type="number" value="${item.qta}" min="0" style="width: 50px; text-align: center;" onchange="aggiornaQtaStampa(${index}, this.value)">
                </div>
            `;
            container.appendChild(row);
        });
    }
    aggiornaAnteprimaStampa();
}

window.aggiornaAnteprimaStampa = function () {
    let layout = document.getElementById('stampa-layout').value;
    let container = document.getElementById('anteprima-etichetta-container');
    container.innerHTML = '';

    if (codaStampa.length === 0) return;

    // Mostriamo l'anteprima basata sul PRIMO elemento in coda
    let item = codaStampa[0];
    let html = generaHTMLSingolaEtichetta(item, layout, 'preview');
    container.innerHTML = html;

    // Genera graficamente il barcode usando JsBarcode sul canvas appena inserito
    JsBarcode("#preview-barcode", item.codice, {
        format: "CODE128", // CODE128 gestisce sia EAN che codici alfanumerici interni
        width: layout === 'small' ? 1 : 1.5,
        height: layout === 'small' ? 30 : 40,
        displayValue: false, // Nascondiamo i numeri sotto il barcode (li mettiamo noi custom)
        margin: 0
    });
};
function generaHTMLSingolaEtichetta(item, layout, mode) {
    // mode può essere 'preview' (classi CSS grandi per lo schermo) o 'print' (classi millimetriche per la carta)
    let wrapperClass = `label-template ${mode}-${layout}`;
    let idCanvas = mode === 'preview' ? 'preview-barcode' : `print-barcode-${Math.random().toString(36).substr(2, 9)}`;

    let nomeEsteso = `${item.descrizione} ${item.formato}`.trim();
    let prezzoDisplay = `€ ${item.prezzo.toFixed(2).replace('.', ',')}`;
    let promoDisplay = item.prezzo_promo > 0 ? `€ ${item.prezzo_promo.toFixed(2).replace('.', ',')}` : '';

    if (layout === 'standard') {
        return `
            <div class="${wrapperClass}">
                <div class="label-brand">${item.brand}</div>
                <div class="label-desc">${nomeEsteso}</div>
                <canvas id="${idCanvas}"></canvas>
                <div class="label-code">${item.codice}</div>
                <div class="label-price">${prezzoDisplay}</div>
                <div class="label-lotto">Lotto: ${item.lotto_stampato}</div>
            </div>
        `;
    } else if (layout === 'promo') {
        return `
            <div class="${wrapperClass}">
                <div class="label-brand">${item.brand}</div>
                <div class="label-desc">${nomeEsteso}</div>
                <canvas id="${idCanvas}"></canvas>
                <div class="label-price-box">
                    ${item.prezzo_promo > 0 ? `<span class="label-price-old">${prezzoDisplay}</span> <span class="label-price" style="color:red;">${promoDisplay}</span>` : `<span class="label-price">${prezzoDisplay}</span>`}
                </div>
                <div class="label-code">${item.codice}</div>
                <div class="label-lotto">Lotto: ${item.lotto_stampato}</div>
            </div>
        `;
    } else if (layout === 'small') {
        return `
            <div class="${wrapperClass}">
                <div class="label-price">${item.prezzo_promo > 0 ? promoDisplay : prezzoDisplay}</div>
                <canvas id="${idCanvas}"></canvas>
                <div class="label-code">${item.codice}</div>
                <div class="label-lotto">Lotto: ${item.lotto_stampato}</div>
            </div>
        `;
    }
}

window.eseguiStampaEtichette = function () {
    if (codaStampa.length === 0) {
        mostraAvvisoModale("La coda di stampa è vuota.");
        return;
    }

    let layout = document.getElementById('stampa-layout').value;
    let printArea = document.getElementById('print-area');
    printArea.innerHTML = '';

    let canvasIds = []; // Salviamo gli ID dei canvas per popolarli dopo averli inseriti nel DOM

    codaStampa.forEach(item => {
        for (let i = 0; i < item.qta; i++) {
            // Un trucco: estraiamo l'ID generato dalla funzione html
            let html = generaHTMLSingolaEtichetta(item, layout, 'print');
            let tempDiv = document.createElement('div');
            tempDiv.innerHTML = html;
            let canvasNode = tempDiv.querySelector('canvas');
            canvasIds.push({ id: canvasNode.id, code: item.codice });
            printArea.appendChild(tempDiv.firstElementChild);
        }
    });

    // Renderizza i barcode reali
    canvasIds.forEach(c => {
        JsBarcode("#" + c.id, c.code, {
            format: "CODE128",
            width: layout === 'small' ? 1 : 1.5,
            height: layout === 'small' ? 20 : 35,
            displayValue: false,
            margin: 0
        });
    });

    // Richiama il driver di stampa del browser
    window.print();
};

// ==========================================
// 🔄 MODULO GESTIONE RESI E CAMBI
// ==========================================

window.apriModaleReso = function () {
    document.getElementById('reso-codice').value = '';
    document.getElementById('reso-descrizione-preview').textContent = '';
    document.getElementById('reso-prezzo').value = '';
    document.getElementById('reso-scontrino-rif').value = '';
    apriModale('modal-inserisci-reso');
    setTimeout(() => document.getElementById('reso-codice').focus(), 100);
};

window.cercaProdottoReso = async function (codice) {
    if (!codice) return;
    let store = db.transaction('magazzino', 'readonly').objectStore('magazzino');
    let req = store.get(codice);
    req.onsuccess = function () {
        if (req.result) {
            let p = req.result;
            document.getElementById('reso-descrizione-preview').textContent = p.descrizione;
            // Prepopoliamo il prezzo di listino, ma l'operatore può (e deve) correggerlo se era scontato
            if (document.getElementById('reso-prezzo').value === '') {
                document.getElementById('reso-prezzo').value = (p.prezzo_promo > 0 ? p.prezzo_promo : p.prezzo).toLocaleString('it-IT', { minimumFractionDigits: 2 });
            }
        } else {
            document.getElementById('reso-descrizione-preview').textContent = "⚠️ Articolo non trovato in anagrafica.";
            document.getElementById('reso-descrizione-preview').style.color = "#ff4d4d";
        }
    };
};

window.confermaInserimentoReso = async function () {
    let codice = document.getElementById('reso-codice').value.trim();
    let prezzoStr = document.getElementById('reso-prezzo').value.replace(',', '.');
    let prezzo = parseFloat(prezzoStr) || 0;

    if (!codice || prezzo <= 0) {
        mostraAvvisoModale("Devi inserire un codice articolo valido e un prezzo di reso maggiore di zero.");
        return;
    }

    let p = await getProdottoDaMagazzino(codice);
    let descrizione = p ? p.descrizione : "Articolo Fuori Catalogo";
    let categoria = p ? p.categoria : "VARIE";

    // Creiamo l'oggetto reso pronto per la cassa
    let articoloReso = {
        codice: "RES-" + codice, // Il prefisso impedisce fusioni errate con i normali acquisti in cassa
        codice_originale: codice, // Manteniamo la memoria del vero EAN per poterlo ricaricare in magazzino
        descrizione: "🔄 RESO: " + descrizione,
        categoria: categoria,
        prezzo: -Math.abs(prezzo), // Forza il prezzo a essere sempre negativo
        giacenza: "-",
        is_reso: true,
        reso_motivo: document.getElementById('reso-motivo').value,
        reso_stato: document.getElementById('reso-stato').value,
        reso_scontrino: document.getElementById('reso-scontrino-rif').value,
        is_kit: p ? p.is_kit : false,
        tipo_kit: p ? p.tipo_kit : null,
        componenti_kit: p ? p.componenti_kit : null,
        tipo: "PZ",
        qta: 1
    };

    // Usiamo la TUA funzione nativa per iniettarlo nello scontrino!
    aggiungiProdotto(articoloReso);
    chiudiModale('modal-inserisci-reso');
};

// Helper per recuperare un singolo prodotto come Promise
function getProdottoDaMagazzino(codice) {
    return new Promise((resolve) => {
        let store = db.transaction('magazzino', 'readonly').objectStore('magazzino');
        let req = store.get(codice);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
    });
}

// ==========================================
// 🎟️ MOTORE VOUCHER E BUONI RESO
// ==========================================

window.applicaVoucherCassa = async function () {
    let inputCampo = document.getElementById('cassa-voucher-input');
    let codice = inputCampo.value.trim().toUpperCase();
    if (!codice) return;

    // Evita di inserire lo stesso buono o carta due volte
    let giaInserito = carrello.find(i => i.codice === codice);
    if (giaInserito) {
        mostraAvvisoModale("Questo codice è già presente nello scontrino attuale.");
        return;
    }

    if (codice.startsWith('GC')) {
        // --- LOGICA GIFT CARD (Pagamento a scalare) ---
        let gc = await getRecordById('giftcards', codice);
        if (gc) {
            if (gc.stato !== 'ATTIVA') {
                mostraAvvisoModale(`Operazione negata: Questa Gift Card risulta <b>${gc.stato}</b>.`);
                inputCampo.value = ''; return;
            }
            if (gc.saldo <= 0) {
                mostraAvvisoModale("Il credito di questa Gift Card è esaurito.");
                inputCampo.value = ''; return;
            }
            if (totaleNettoAttuale <= 0) {
                mostraAvvisoModale("Il totale dello scontrino è già a zero. Non puoi scalare altro credito.");
                return;
            }

            // Calcola quanto prelevare: il minimo tra il totale da pagare e il saldo della carta
            let importoDaScalare = Math.min(totaleNettoAttuale, gc.saldo);

            let prodGC = {
                codice: gc.codice,
                descrizione: "💳 PAGAMENTO CON GIFT CARD",
                giacenza: "-",
                prezzo: -importoDaScalare, // Prezzo negativo perché abbatte il totale scontrino
                categoria: "GIFT_CARD_USO",
                is_giftcard_uso: true,
                tipo: "GC"
            };
            aggiungiProdotto(prodGC);
            inputCampo.value = '';
        } else {
            mostraAvvisoModale("Gift Card non trovata nel database.");
            inputCampo.value = '';
        }

    } else {
        // --- LOGICA CLASSICA VOUCHER / BUONO RESO ---
        let tx = db.transaction('vouchers', 'readonly');
        let store = tx.objectStore('vouchers');
        let req = store.get(codice);

        req.onsuccess = function () {
            if (req.result) {
                let v = req.result;
                let prodVoucher = {
                    codice: v.codice,
                    descrizione: "🎟️ BUONO RESO SCALATO",
                    giacenza: "-",
                    prezzo: -Math.abs(v.importo),
                    categoria: "VOUCHER",
                    tipo: "VOUCHER"
                };
                aggiungiProdotto(prodVoucher);
                inputCampo.value = '';
            } else {
                mostraAvvisoModale("⚠️ VOUCHER NON VALIDO<br>Il codice inserito non esiste, è scaduto oppure è già stato utilizzato.");
                inputCampo.value = '';
            }
        };
    }
};

// Permette di sparare il voucher col lettore senza dover premere il tasto "APPLICA"
document.getElementById('cassa-voucher-input').addEventListener('keypress', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); applicaVoucherCassa(); }
});

window.stampaVoucherTermico = function (codice, importo) {
    let printArea = document.getElementById('print-area');

    // Aggiunto padding interno e ridimensionato i font per evitare tagli
    printArea.innerHTML = `
        <div class="label-template print-standard" style="text-align: center; font-family: Arial, sans-serif; display: flex; flex-direction: column; justify-content: center; box-sizing: border-box; padding: 4mm 2mm;">
            <div style="font-weight: bold; font-size: 12pt; margin-bottom: 1mm; margin-top: 2mm;">BUONO RESO</div>
            <div style="font-size: 16pt; font-weight: bold; margin-bottom: 2mm;">€ ${importo.toFixed(2).replace('.', ',')}</div>
            <canvas id="voucher-barcode"></canvas>
            <div style="font-size: 7pt; margin-top: 2mm; margin-bottom: 2mm; color: #333;">Scadenza: 12 Mesi</div>
        </div>
    `;

    // Genera il barcode (Altezza ridotta da 35 a 25 per fare spazio ai testi)
    JsBarcode("#voucher-barcode", codice, {
        format: "CODE128",
        width: 1.5,
        height: 25,
        displayValue: true,
        fontSize: 10,
        margin: 0
    });

    // Lancia la stampa dopo mezzo secondo per dar tempo al canvas di disegnarsi
    setTimeout(() => window.print(), 500);
};

// ==========================================
// 📦 MODULO GESTIONE ORDINI E CICLO PASSIVO
// ==========================================

let ordineApertoAttuale = null;

window.apriModaleOrdini = function () {
    document.getElementById('filtro-stato-ordini').value = 'TUTTI';
    caricaListaOrdini();
    apriModale('modal-gestione-ordini');
};

window.caricaListaOrdini = function () {
    let filtro = document.getElementById('filtro-stato-ordini').value;
    let tx = db.transaction('ordini', 'readonly');
    let store = tx.objectStore('ordini');
    let req = store.getAll();

    req.onsuccess = function () {
        let ordini = req.result || [];
        ordini.sort((a, b) => b.id_ordine - a.id_ordine); // Ordina dal più recente

        let tbody = document.getElementById('body-lista-ordini');
        tbody.innerHTML = '';

        let filtrati = ordini.filter(o => filtro === 'TUTTI' || o.stato === filtro);

        if (filtrati.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px; color: #888;">Nessun ordine trovato.</td></tr>';
            return;
        }

        filtrati.forEach(o => {
            let tr = document.createElement('tr');
            tr.style.borderBottom = "1px solid rgba(255,255,255,0.05)";
            let totale = o.articoli.reduce((acc, a) => acc + ((a.prezzoAcquisto || 0) * a.qta_ordinata), 0);

            // Icone di stato
            let iconaStato = o.stato === 'BOZZA' ? '📝' : o.stato === 'INVIATO' ? '📨' : o.stato === 'PARZIALE' ? '📦' : '✅';
            let coloreStato = o.stato === 'BOZZA' ? '#b3d9ff' : o.stato === 'INVIATO' ? '#ffcc00' : '#00ffcc';

            tr.innerHTML = `
                <td style="padding: 10px; text-align: left; color: #888;">#${o.id_ordine}</td>
                <td style="padding: 10px; text-align: left;">${o.data}</td>
                <td style="padding: 10px; text-align: left; font-weight: bold;">${o.fornitore}</td>
                <td style="padding: 10px; text-align: center; color: #ffcc00;">€ ${totale.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</td>
                <td style="padding: 10px; text-align: center; font-weight: bold; color: ${coloreStato};">${iconaStato} ${o.stato}</td>
                <td style="padding: 10px; text-align: center;">
                    <button class="btn-modal btn-grigio" style="padding: 5px 15px; margin: 0; font-size: 1.2vh;" onclick="apriDettaglioOrdine(${o.id_ordine})">🔍 DETTAGLI</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    };
};

// ⚡ CUORE DEL SISTEMA: MOTORE GENERAZIONE SOTTOSCORTA
window.generaOrdineDaSottoscorta = function () {
    let tx = db.transaction('magazzino', 'readonly');
    let store = tx.objectStore('magazzino');
    let req = store.getAll();

    req.onsuccess = function () {
        let magazzino = req.result || [];

        // Cerca i prodotti con scorta_minima > 0, che sono scesi sotto soglia e NON sono Kit o Voucher
        let daOrdinare = magazzino.filter(p => p.scorta_minima > 0 && p.giacenza < p.scorta_minima && !p.is_kit && p.tipo !== 'VOUCHER');

        if (daOrdinare.length === 0) {
            mostraAvvisoModale("Ottimo lavoro!<br>Il magazzino è in salute e nessun articolo è sotto la soglia di scorta minima.");
            return;
        }

        let raggruppati = {}; // Raggruppa per fornitore

        daOrdinare.forEach(p => {
            let f = p.fornitore ? p.fornitore.toUpperCase() : "FORNITORE SCONOSCIUTO";
            if (!raggruppati[f]) raggruppati[f] = [];

            // Logica d'acquisto: ordiniamo i pezzi mancanti per arrivare ALMENO alla scorta minima
            let giacenzaReale = p.giacenza > 0 ? p.giacenza : 0;
            let qtaDaComprare = p.scorta_minima - giacenzaReale;

            raggruppati[f].push({
                codice: p.codice,
                descrizione: p.descrizione,
                prezzoAcquisto: p.prezzoAcquisto || 0,
                qta_ordinata: qtaDaComprare,
                qta_ricevuta: 0 // Inizializzato a zero, servirà per il Carico Merce
            });
        });

        let txOrd = db.transaction('ordini', 'readwrite');
        let storeOrd = txOrd.objectStore('ordini');
        let contatoreBozze = 0;

        for (let fornitore in raggruppati) {
            let nuovoOrdine = {
                id_ordine: Date.now() + contatoreBozze, // ID univoco per il database
                data: getOggiString(),
                fornitore: fornitore,
                stato: 'BOZZA',
                articoli: raggruppati[fornitore],
                spese_spedizione: 0
            };
            storeOrd.add(nuovoOrdine);
            salvaOrdineCloud(nuovoOrdine);
            contatoreBozze++;
        }

        txOrd.oncomplete = function () {
            mostraAvvisoModale(`<b>ANALISI COMPLETATA</b><br><br>Sono state generate <b>${contatoreBozze}</b> bozze d'ordine divise per fornitore.<br><br>Puoi aprirle per modificarle o confermare l'invio.`);
            caricaListaOrdini();
        };
    };
};

window.apriDettaglioOrdine = function (id) {
    let tx = db.transaction('ordini', 'readonly');
    let req = tx.objectStore('ordini').get(id);

    req.onsuccess = function () {
        if (!req.result) return;
        ordineApertoAttuale = req.result;

        document.getElementById('titolo-dettaglio-ordine').textContent = `ORDINE #${ordineApertoAttuale.id_ordine}`;
        document.getElementById('ord-fornitore').value = ordineApertoAttuale.fornitore;
        document.getElementById('ord-stato').value = ordineApertoAttuale.stato;

        let btnElimina = document.getElementById('btn-elimina-ord');
        let btnRicevi = document.getElementById('btn-ricevi-merci');
        let campoFornitore = document.getElementById('ord-fornitore');
        let barraRicerca = document.getElementById('sezione-ricerca-ordine');

        // Logica bottoni e visibilità in base allo stato
        if (ordineApertoAttuale.stato === 'BOZZA') {
            btnElimina.style.display = 'block';
            btnRicevi.style.display = 'none';
            document.getElementById('ord-stato').disabled = false;
            campoFornitore.removeAttribute('readonly');
            if (barraRicerca) barraRicerca.style.display = 'block';
        } else if (ordineApertoAttuale.stato === 'INVIATO' || ordineApertoAttuale.stato === 'PARZIALE') {
            btnElimina.style.display = 'none';
            btnRicevi.style.display = 'block';
            document.getElementById('ord-stato').disabled = false;
            campoFornitore.setAttribute('readonly', 'true');
            if (barraRicerca) barraRicerca.style.display = 'none';
        } else {
            // Chiuso
            btnElimina.style.display = 'none';
            btnRicevi.style.display = 'none';
            document.getElementById('ord-stato').disabled = true;
            campoFornitore.setAttribute('readonly', 'true');
            if (barraRicerca) barraRicerca.style.display = 'none';
        }

        disegnaArticoliOrdine();
        apriModale('modal-dettaglio-ordine');
    };
};
function disegnaArticoliOrdine() {
    let tbody = document.getElementById('body-articoli-ordine');
    tbody.innerHTML = '';
    let totaleOrdine = 0;

    ordineApertoAttuale.articoli.forEach((art, idx) => {
        let costoCad = art.prezzoAcquisto || 0;
        let totRiga = costoCad * art.qta_ordinata;
        totaleOrdine += totRiga;

        // Se l'ordine non è ancora chiuso, permettiamo di aggiustare le quantità manualmente
        let inputQta = ordineApertoAttuale.stato === 'BOZZA' || ordineApertoAttuale.stato === 'INVIATO'
            ? `<input type="number" value="${art.qta_ordinata}" min="1" style="width: 60px; text-align: center; border-radius: 4px; border: 1px solid #4d88ff; background: rgba(0,0,0,0.5); color: white; padding: 5px;" onchange="aggiornaQtaArticoloOrdine(${idx}, this.value)">`
            : `<b>${art.qta_ordinata}</b>`;

        let tr = document.createElement('tr');
        tr.style.borderBottom = "1px solid rgba(255,255,255,0.05)";
        tr.innerHTML = `
            <td style="padding: 10px; text-align: left; color: #888;">${art.codice}</td>
            <td style="padding: 10px;text-align: left;">${art.descrizione}</td>
            <td style="padding: 10px; text-align: center;">€ ${costoCad.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</td>
            <td style="padding: 10px; text-align: center;">${inputQta}</td>
            <td style="padding: 10px; text-align: center; color: #ffcc00; font-weight: bold;">€ ${totRiga.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</td>
        `;
        tbody.appendChild(tr);
    });

    document.getElementById('ord-totale').textContent = `€ ${totaleOrdine.toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;
}

window.aggiornaQtaArticoloOrdine = function (indice, nuovaQta) {
    let qta = parseInt(nuovaQta);
    if (qta > 0 && ordineApertoAttuale) {
        ordineApertoAttuale.articoli[indice].qta_ordinata = qta;
        disegnaArticoliOrdine(); // Ricalcola i totali in tempo reale
    }
};

window.salvaModificheOrdine = function () {
    if (!ordineApertoAttuale) return;

    if (!document.getElementById('ord-stato').disabled) {
        ordineApertoAttuale.stato = document.getElementById('ord-stato').value;
    }

    // Salviamo il nome del fornitore se è stato modificato
    let nomeFornitore = document.getElementById('ord-fornitore').value.trim().toUpperCase();
    if (nomeFornitore) ordineApertoAttuale.fornitore = nomeFornitore;

    let tx = db.transaction('ordini', 'readwrite');
    tx.objectStore('ordini').put(ordineApertoAttuale);

    tx.oncomplete = function () {
        mostraAvvisoModale("✅ Ordine salvato con successo!");
        chiudiModale('modal-dettaglio-ordine');
        caricaListaOrdini();
        salvaOrdineCloud(ordineApertoAttuale);
    };
};

window.eliminaOrdineCorrente = function () {
    if (!ordineApertoAttuale) return;
    if (ordineApertoAttuale.stato !== 'BOZZA') {
        mostraAvvisoModale("Attenzione: Puoi eliminare solo gli ordini in stato di 'Bozza'.");
        return;
    }

    let tx = db.transaction('ordini', 'readwrite');
    tx.objectStore('ordini').delete(ordineApertoAttuale.id_ordine);
    tx.oncomplete = function () {
        chiudiModale('modal-dettaglio-ordine');
        caricaListaOrdini();
        eliminaOrdineCloud(ordineApertoAttuale.id_ordine);
    };
};

// ==========================================
// 📦 LOGICA RICEZIONE MERCE E CARICO MAGAZZINO
// ==========================================

window.apriModaleCaricoMerce = function () {
    // Inizializza le quantità ricevute a zero prima di iniziare la spunta
    ordineApertoAttuale.articoli.forEach(a => a.qta_ricevuta = 0);
    document.getElementById('carico-spese').value = '';
    document.getElementById('carico-barcode-scanner').value = '';

    disegnaTabellaCarico();
    apriModale('modal-carico-merce');

    setTimeout(() => document.getElementById('carico-barcode-scanner').focus(), 100);
};

function disegnaTabellaCarico() {
    let tbody = document.getElementById('body-carico-merce');
    tbody.innerHTML = '';

    ordineApertoAttuale.articoli.forEach((art, idx) => {
        if (art.qta_ordinata <= 0) return; // Se è già stato tutto ricevuto in passato

        let tr = document.createElement('tr');
        tr.style.borderBottom = "1px solid rgba(255,255,255,0.05)";

        // Evidenzia la riga se la spunta è completa
        if (art.qta_ricevuta === art.qta_ordinata) tr.style.background = "rgba(0, 204, 102, 0.2)";

        tr.innerHTML = `
            <td style="padding: 10px; text-align: left; color: #888;">${art.codice}</td>
            <td style="padding: 10px; text-align: left; font-weight: ${art.qta_ricevuta > 0 ? 'bold' : 'normal'};">${art.descrizione}</td>
            <td style="padding: 10px; text-align: center; color: #ffcc00; font-weight: bold; font-size: 2vh;">${art.qta_ordinata}</td>
            <td style="padding: 10px; text-align: center;">
                <div style="display: flex; align-items: center; justify-content: center; gap: 5px;">
                    <button class="btn-modal btn-verde" style="width: 35px; height: 30px; padding: 0; margin: 0; display: flex; align-items: center; justify-content: center; font-size: 2.5vh; font-weight: bold;" onclick="aggiustaQtaCarico(${idx}, -1)">-</button>
                    <input type="number" value="${art.qta_ricevuta}" min="0" max="${art.qta_ordinata}" style="width: 50px; height: 30px; text-align: center; font-size: 2vh; font-weight: bold; color: #00cc66; background: rgba(0,0,0,0.5); border: 1px solid #00cc66; box-sizing: border-box;" readonly>
                    <button class="btn-modal btn-verde" style="width: 35px; height: 30px; padding: 0; margin: 0; display: flex; align-items: center; justify-content: center; font-size: 2.5vh; font-weight: bold;" onclick="aggiustaQtaCarico(${idx}, 1)">+</button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

window.aggiustaQtaCarico = function (idx, delta) {
    let art = ordineApertoAttuale.articoli[idx];
    let nuovaQta = art.qta_ricevuta + delta;
    if (nuovaQta >= 0 && nuovaQta <= art.qta_ordinata) {
        art.qta_ricevuta = nuovaQta;
        disegnaTabellaCarico();
    }
};

// Lettore Barcode
document.getElementById('carico-barcode-scanner').addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        let code = this.value.trim();
        this.value = '';

        let idx = ordineApertoAttuale.articoli.findIndex(a => a.codice === code);
        if (idx >= 0) {
            let art = ordineApertoAttuale.articoli[idx];
            if (art.qta_ricevuta < art.qta_ordinata) {
                aggiustaQtaCarico(idx, 1);
            } else {
                mostraAvvisoModale("Hai già spuntato tutti i pezzi attesi per questo articolo.");
            }
        } else {
            mostraAvvisoModale("Articolo non presente in questo ordine.");
        }
    }
});

// Conferma il carico (Versione Definitiva con Storico Intatto)
window.confermaCaricoMerce = function () {
    let pezziTotaliRicevuti = ordineApertoAttuale.articoli.reduce((acc, a) => acc + (parseInt(a.qta_ricevuta) || 0), 0);

    if (pezziTotaliRicevuti === 0) {
        mostraAvvisoModale("Non hai spuntato nessuna quantità in arrivo.");
        return;
    }

    let speseStr = document.getElementById('carico-spese').value.replace(',', '.');
    let speseSpedizione = parseFloat(speseStr) || 0;

    // Quota spese da sommare al costo di OGNI singolo pezzo
    let quotaSpesePerPezzo = speseSpedizione / pezziTotaliRicevuti;
    let stampaEtichette = document.getElementById('carico-stampa-etichette').checked;

    let tx = db.transaction(['magazzino', 'ordini'], 'readwrite');
    let storeMag = tx.objectStore('magazzino');
    let storeOrd = tx.objectStore('ordini');

    let pezziRimastiAttesi = 0;

    for (let art of ordineApertoAttuale.articoli) {
        let quantitaDaAggiungere = parseInt(art.qta_ricevuta) || 0;

        if (quantitaDaAggiungere > 0) {
            let req = storeMag.get(art.codice);
            req.onsuccess = function () {
                if (req.result) {
                    let prodotto = req.result;
                    prodotto.giacenza = parseInt(prodotto.giacenza || 0) + quantitaDaAggiungere;

                    if (!prodotto.lotti) prodotto.lotti = [];
                    prodotto.lotti.push({
                        codice_lotto: document.getElementById('carico-input-lotto').value.trim() || `L-${Date.now()}`,
                        qta_iniziale: quantitaDaAggiungere,
                        qta_residua: quantitaDaAggiungere,
                        data_carico: getOggiString(),
                        data_apertura: null, // Verrà compilata al primo scarico in cassa
                        pao_mesi: parseInt(document.getElementById('carico-input-pao').value) || 36
                    });

                    let nuovoCosto = (parseFloat(art.prezzoAcquisto) || 0) + quotaSpesePerPezzo;
                    prodotto.prezzoAcquisto = parseFloat(nuovoCosto.toFixed(2));

                    storeMag.put(prodotto);

                    if (stampaEtichette) {
                        aggiungiACodaStampa({
                            codice: prodotto.codice,
                            brand: prodotto.brand || '',
                            descrizione: prodotto.descrizione,
                            formato: prodotto.formato || '',
                            prezzo: prodotto.prezzo,
                            prezzo_promo: prodotto.prezzo_promo || 0
                        }, quantitaDaAggiungere);
                    }
                }
            };
        }

        // FIX: Non distruggiamo più la qta_ordinata originale!
        // Segniamo solo quanti pezzi sono arrivati nel corso del tempo
        art.qta_consegnata = (parseInt(art.qta_consegnata) || 0) + quantitaDaAggiungere;

        // Calcoliamo se mancano ancora pezzi per questo articolo
        let mancanti = parseInt(art.qta_ordinata) - art.qta_consegnata;
        if (mancanti > 0) pezziRimastiAttesi += mancanti;

        art.qta_ricevuta = 0; // Azzera il campetto input per il futuro
    }

    // Se non ci sono più pezzi in sospeso, l'ordine è chiuso
    ordineApertoAttuale.stato = pezziRimastiAttesi <= 0 ? 'CHIUSO' : 'PARZIALE';
    storeOrd.put(ordineApertoAttuale);

    tx.oncomplete = function () {
        chiudiModale('modal-carico-merce');
        chiudiModale('modal-dettaglio-ordine');

        if (typeof caricaListaOrdini === "function") caricaListaOrdini();
        if (typeof salvaOrdineCloud === "function") salvaOrdineCloud(ordineApertoAttuale);

        // FIX: Ora mostriamo l'avviso in ENTRAMBI i casi!
        if (stampaEtichette) {
            if (typeof aggiornaUIStampa === "function") aggiornaUIStampa();
            apriModale('modal-stampa-etichette');
            mostraAvvisoModale(`✅ <b>CARICO COMPLETATO</b><br><br>Sono stati caricati in giacenza ${pezziTotaliRicevuti} pezzi.<br>Li trovi ora nella coda di stampa.`);
        } else {
            mostraAvvisoModale(`✅ <b>CARICO COMPLETATO</b><br><br>Sono stati caricati in giacenza ${pezziTotaliRicevuti} pezzi.`);
        }
    };
};

// --- LOGICA CREAZIONE MANUALE E RICERCA ARTICOLI ---
window.creaNuovoOrdineManuale = function () {
    let nuovoOrdine = {
        id_ordine: Date.now(),
        data: new Date().toLocaleDateString('it-IT', { year: 'numeric', month: '2-digit', day: '2-digit' }),
        fornitore: "FORNITORE DA DEFINIRE", // Placeholder che potrai sovrascrivere
        stato: 'BOZZA',
        articoli: [],
        spese_spedizione: 0
    };

    let tx = db.transaction('ordini', 'readwrite');
    tx.objectStore('ordini').add(nuovoOrdine);

    tx.oncomplete = function () {
        caricaListaOrdini();
        apriDettaglioOrdine(nuovoOrdine.id_ordine);
        salvaOrdineCloud(nuovoOrdine);
    };
};

// Autocompletamento ricerca articolo manuale nell'ordine
document.getElementById('ord-cerca-articolo').addEventListener('input', function () {
    let txt = this.value.toLowerCase().trim();
    let listaHTML = document.getElementById('ord-lista-ricerca');
    listaHTML.innerHTML = '';

    if (txt.length < 2) { listaHTML.style.display = 'none'; return; }

    let tx = db.transaction('magazzino', 'readonly');
    let store = tx.objectStore('magazzino');
    let req = store.getAll();

    req.onsuccess = function () {
        let magazzino = req.result || [];
        // Filtra prodotti normali (no kit, no voucher) che matchano la ricerca
        let filtrati = magazzino.filter(p => !p.is_kit && p.tipo !== 'VOUCHER' && (p.codice.toLowerCase().includes(txt) || p.descrizione.toLowerCase().includes(txt)));

        if (filtrati.length > 0) {
            listaHTML.style.display = 'block';
            filtrati.forEach(p => {
                let div = document.createElement('div');
                div.className = 'voce-lista';
                div.innerHTML = `<span style="color:#666;">[${p.codice}]</span> ${p.descrizione}`;
                div.style.padding = "10px";
                div.style.borderBottom = "1px solid rgba(255,255,255,0.1)";
                div.style.cursor = "pointer";

                div.addEventListener('click', () => {
                    aggiungiArticoloAOrdineManuale(p);
                    document.getElementById('ord-cerca-articolo').value = '';
                    listaHTML.style.display = 'none';
                });
                listaHTML.appendChild(div);
            });
        } else {
            listaHTML.style.display = 'none';
        }
    };
});

function aggiungiArticoloAOrdineManuale(p) {
    if (!ordineApertoAttuale) return;

    let giaPresente = ordineApertoAttuale.articoli.find(a => a.codice === p.codice);
    if (giaPresente) {
        giaPresente.qta_ordinata++;
    } else {
        ordineApertoAttuale.articoli.push({
            codice: p.codice,
            descrizione: p.descrizione,
            prezzoAcquisto: p.prezzoAcquisto || 0,
            qta_ordinata: 1,
            qta_ricevuta: 0
        });
    }
    disegnaArticoliOrdine(); // Ricarica immediatamente la tabella per mostrare il nuovo inserimento
}

// ==========================================
// 📄 ESPORTAZIONE ORDINE IN PDF (A4)
// ==========================================
window.stampaOrdinePDF = function () {
    if (!ordineApertoAttuale) return;

    let printArea = document.getElementById('print-area');
    let tbody = '';
    let totale = 0;

    ordineApertoAttuale.articoli.forEach(art => {
        let rigaTot = art.qta_ordinata * (art.prezzoAcquisto || 0);
        totale += rigaTot;
        tbody += `
            <tr>
                <td style="padding: 10px; border: 1px solid #ccc;">${art.codice}</td>
                <td style="padding: 10px; border: 1px solid #ccc;"><b>${art.descrizione}</b></td>
                <td style="padding: 10px; border: 1px solid #ccc; text-align: center;">${art.qta_ordinata}</td>
                <td style="padding: 10px; border: 1px solid #ccc; text-align: right;">€ ${(art.prezzoAcquisto || 0).toLocaleString('it-IT', { minimumFractionDigits: 2 })}</td>
                <td style="padding: 10px; border: 1px solid #ccc; text-align: right; font-weight: bold;">€ ${rigaTot.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</td>
            </tr>`;
    });

    // Struttura A4
    printArea.innerHTML = `
        <div class="print-a4" style="color: black; font-family: Arial, sans-serif; background: white;">
            <div style="display: flex; justify-content: space-between; border-bottom: 2px solid #333; padding-bottom: 20px; margin-bottom: 30px;">
                <div>
                    <h1 style="margin: 0; color: #002b5e;">PROPOSTA D'ACQUISTO</h1>
                    <p style="margin: 5px 0 0 0; color: #555;">Ordine #${ordineApertoAttuale.id_ordine}</p>
                </div>
                <div style="text-align: right;">
                    <p style="margin: 0;"><b>Data:</b> ${ordineApertoAttuale.data}</p>
                    <p style="margin: 5px 0 0 0;"><b>Stato:</b> ${ordineApertoAttuale.stato}</p>
                </div>
            </div>
            
            <div style="margin-bottom: 30px; font-size: 18px;">
                Fornitore / Brand: <b>${ordineApertoAttuale.fornitore}</b>
            </div>

            <table style="width: 100%; border-collapse: collapse;">
                <thead>
                    <tr style="background-color: #f0f0f0;">
                        <th style="padding: 10px; border: 1px solid #ccc; text-align: left;">Codice EAN</th>
                        <th style="padding: 10px; border: 1px solid #ccc; text-align: left;">Descrizione Articolo</th>
                        <th style="padding: 10px; border: 1px solid #ccc; text-align: center;">Q.tà</th>
                        <th style="padding: 10px; border: 1px solid #ccc; text-align: right;">Costo Unit.</th>
                        <th style="padding: 10px; border: 1px solid #ccc; text-align: right;">Totale Riga</th>
                    </tr>
                </thead>
                <tbody>${tbody}</tbody>
                <tfoot>
                    <tr style="background-color: #002b5e; color: white;">
                        <td colspan="4" style="padding: 15px; text-align: right; font-size: 18px;"><b>TOTALE ORDINE STIMATO:</b></td>
                        <td style="padding: 15px; text-align: right; font-size: 18px;"><b>€ ${totale.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</b></td>
                    </tr>
                </tfoot>
            </table>
            
            <div style="margin-top: 50px; text-align: center; color: #888; font-size: 12px;">
                Documento generato automaticamente da Cassa PWA Gestionale.
            </div>
        </div>
    `;

    // Attende che il DOM si aggiorni e poi chiama la finestra di stampa
    setTimeout(() => window.print(), 500);
};

// ==========================================
// 🔒 MODULO CHIUSURA GIORNALIERA FISCALE (Z)
// ==========================================

let datiChiusuraAttuale = {}; // Oggetto in cui salviamo tutti i calcoli per il PDF

window.apriModaleChiusuraCassa = async function () {
    let dataOggi = getOggiString();

    // Controlla se la giornata è già stata chiusa
    let txC = db.transaction('chiusure', 'readonly');
    let reqC = txC.objectStore('chiusure').get(dataOggi);

    reqC.onsuccess = async function () {
        if (reqC.result) {
            mostraAvvisoModale(`⚠️ <b>GIORNATA GIÀ CHIUSA</b><br><br>La chiusura fiscale per la data ${dataOggi} è già stata effettuata dall'operatore ${reqC.result.operatore}. Non è possibile eseguirla due volte.`);
            return;
        }

        // --- ESTRAZIONE DATI ---
        let venditeOggi = await getByDate('vendite', 'giorno', dataOggi);
        let movimentiOggi = await getByDate('movimenti_cassa', 'data', dataOggi);

        // --- ESTRAZIONE DATI FISCALI E IVA ---
        let lordo = 0; let sconti = 0; let resi = 0; let contanti = 0; let pos = 0; let voucher = 0;
        let entrate = 0; let uscite = 0; let ivaBreakdown = {};
        let giftCardEmesse = 0; // 🔥 NOVITÀ: Tracciamento emissioni GC (FC IVA)

        venditeOggi.forEach(v => {
            sconti += (v.BONUS || 0);

            v.ARTICOLI.forEach(art => {
                if (art.CODICE === "PUNTI" || art.DESCRIZIONE.includes("MOVIMENTO MANUALE")) return; // Ignora i punti

                let importoRiga = art.IMPORTO;

                // 1. Tracciamento Resi (Negativi)
                if (importoRiga < 0 && art.CODICE.startsWith("RES-")) {
                    resi += Math.abs(importoRiga);
                }
                // 2. Pagamenti con Voucher e GC: NON riducono l'imponibile della merce venduta!
                else if (importoRiga < 0 && (art.CATEGORIA === "VOUCHER" || art.CATEGORIA === "GIFT_CARD_USO")) {
                    voucher += Math.abs(importoRiga);
                }
                // 3. Emissione Gift Card (Voucher Multiuso - Fuori Campo IVA)
                else if (art.CATEGORIA === "GIFT_CARD" || art.CATEGORIA === "GIFT_CARD_RIC") {
                    lordo += importoRiga;
                    giftCardEmesse += importoRiga;
                    // Forza il versamento nel calderone IVA 0%
                    if (!ivaBreakdown[0]) ivaBreakdown[0] = { imponibile: 0, imposta: 0, lordo: 0 };
                    ivaBreakdown[0].lordo += importoRiga;
                    ivaBreakdown[0].imponibile += importoRiga;
                }
                // 4. Merce venduta normale (Calcolo IVA standard)
                else {
                    lordo += importoRiga;
                    let aliquota = art.IVA || 22;
                    if (!ivaBreakdown[aliquota]) ivaBreakdown[aliquota] = { imponibile: 0, imposta: 0, lordo: 0 };
                    ivaBreakdown[aliquota].lordo += importoRiga;
                    let imponibile = importoRiga / (1 + (aliquota / 100));
                    ivaBreakdown[aliquota].imponibile += imponibile;
                    ivaBreakdown[aliquota].imposta += (importoRiga - imponibile);
                }
            });

            contanti += v.CONTANTI;
            pos += v.POS;
        });

        movimentiOggi.forEach(m => {
            if (m.tipo === 'ENTRATA') entrate += m.importo;
            if (m.tipo === 'USCITA') uscite += m.importo;
        });

        let cassettoTeorico = contanti + entrate - uscite;

        // Salviamo in memoria per la stampa e per il Database
        datiChiusuraAttuale = {
            data_chiusura: dataOggi,
            data: dataOggi,
            operatore: operatoreAttivo,
            lordo: lordo, sconti: sconti, resi: resi,
            contanti: contanti, pos: pos, voucher: voucher,
            entrate: entrate, uscite: uscite,
            cassettoTeorico: cassettoTeorico,
            iva: ivaBreakdown,
            differenza: 0,
            fondoCassa: 0,
            giftCardEmesse: giftCardEmesse // Aggiunto al report
        };

        // Aggiorna UI
        document.getElementById('z-teorico-lordo').textContent = `€ ${lordo.toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;

        // Aggiorna UI
        document.getElementById('z-teorico-lordo').textContent = `€ ${lordo.toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;
        document.getElementById('z-teorico-sconti').textContent = `- € ${sconti.toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;
        document.getElementById('z-teorico-resi').textContent = `- € ${resi.toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;
        document.getElementById('z-teorico-pos').textContent = `€ ${pos.toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;
        document.getElementById('z-teorico-voucher').textContent = `€ ${voucher.toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;
        document.getElementById('z-teorico-contanti').textContent = `€ ${contanti.toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;
        document.getElementById('z-teorico-entrate').textContent = `+ € ${entrate.toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;
        document.getElementById('z-teorico-uscite').textContent = `- € ${uscite.toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;
        if (operatoreLoggato && operatoreLoggato.ruolo === 'SALES') {
            document.getElementById('z-teorico-cassetto').textContent = `€ ***,**`; // Nascosto al commesso!
            document.getElementById('z-teorico-lordo').textContent = `€ ***,**`;
            document.getElementById('z-teorico-contanti').textContent = `€ ***,**`;
            document.getElementById('z-teorico-pos').textContent = `€ ***,**`;
        } else {
            document.getElementById('z-teorico-cassetto').textContent = `€ ${cassettoTeorico.toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;
        }

        document.getElementById('z-input-reale').value = '';
        document.getElementById('z-input-fondo').value = '';
        document.getElementById('z-differenza').textContent = '€ 0,00';
        document.getElementById('z-differenza').style.color = 'white';

        chiudiModale('modal-registro-cassa');
        apriModale('modal-chiusura-cassa');
        setTimeout(() => document.getElementById('z-input-reale').focus(), 100);
    };
};

window.calcolaDifferenzaZ = function () {
    let inputReale = document.getElementById('z-input-reale').value.replace(',', '.');
    let reale = parseFloat(inputReale) || 0;

    let differenza = reale - datiChiusuraAttuale.cassettoTeorico;
    datiChiusuraAttuale.differenza = differenza;

    let diffSpan = document.getElementById('z-differenza');
    diffSpan.textContent = `${differenza >= 0 ? '+' : '-'} € ${Math.abs(differenza).toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;

    if (differenza < 0) diffSpan.style.color = '#ff4d4d'; // Rosso se mancano soldi
    else if (differenza > 0) diffSpan.style.color = '#00ffcc'; // Azzurro se ci sono soldi in più
    else diffSpan.style.color = 'white'; // Perfetto
};

// Filtro input per i campi Z
document.getElementById('z-input-reale').addEventListener('input', function () { this.value = this.value.replace(/[^0-9.,]/g, ''); });
document.getElementById('z-input-fondo').addEventListener('input', function () { this.value = this.value.replace(/[^0-9.,]/g, ''); });

// ==========================================
// 🖨️ SALVATAGGIO, STAMPA Z E BLOCCO FISCALE
// ==========================================

window.confermaChiusuraFiscale = async function () {
    let inputReale = document.getElementById('z-input-reale').value.replace(',', '.');
    let reale = parseFloat(inputReale);

    if (isNaN(reale)) {
        mostraAvvisoModale("Devi obbligatoriamente inserire il totale reale dei contanti contati nel cassetto.");
        return;
    }

    let inputFondo = document.getElementById('z-input-fondo').value.replace(',', '.');
    let fondoCassa = parseFloat(inputFondo) || 0;

    // Completiamo l'oggetto con gli input dell'operatore
    datiChiusuraAttuale.reale = reale;
    datiChiusuraAttuale.fondoCassa = fondoCassa;
    datiChiusuraAttuale.contantiDaVersare = reale - fondoCassa;
    datiChiusuraAttuale.timestamp = Date.now();

    // 1. Salva nel DB Locale
    let tx = db.transaction('chiusure', 'readwrite');
    tx.objectStore('chiusure').put(datiChiusuraAttuale);

    tx.oncomplete = function () {
        chiudiModale('modal-chiusura-cassa');

        // 2. Salva nel Cloud Firebase
        if (typeof salvaChiusuraCloud === "function") {
            salvaChiusuraCloud(datiChiusuraAttuale);
        }

        // 🛡️ 3. ESEGUE IL BACKUP DI SICUREZZA FINE GIORNATA
        esportaBackupCompleto(true);

        mostraAvvisoModale(`✅ <b>CHIUSURA Z COMPLETATA</b><br><br>La giornata fiscale è stata sigillata correttamente.<br>Nessuna operazione di oggi potrà più essere modificata o annullata.<br><br>Avvio stampa report in corso...`);

        // 4. Lancia la stampa del ticket termico
        setTimeout(() => stampaChiusuraZ(datiChiusuraAttuale), 2000);
    };
};

window.stampaChiusuraZ = function (dati) {
    let printArea = document.getElementById('print-area');

    // Generiamo le righe dell'IVA dinamicamente
    let ivaHtml = "";
    let totaleNetto = dati.lordo - dati.sconti - dati.resi;

    for (let aliquota in dati.iva) {
        let v = dati.iva[aliquota];
        ivaHtml += `
            <div style="display: flex; justify-content: space-between; font-size: 9pt;">
                <span>Imponibile IVA ${aliquota}%</span> <span>€ ${v.imponibile.toFixed(2).replace('.', ',')}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 9pt; margin-bottom: 1mm;">
                <span>Imposta IVA ${aliquota}%</span> <span>€ ${v.imposta.toFixed(2).replace('.', ',')}</span>
            </div>
        `;
    }

    // Struttura del Report a rotolo (80mm)
    printArea.innerHTML = `
        <div class="print-ticket" style="color: black; font-family: monospace; background: white;">
            <div style="text-align: center; font-weight: bold; font-size: 14pt; margin-bottom: 2mm;">CHIUSURA GIORNALIERA (Z)</div>
            <div style="text-align: center; font-size: 12pt; border-bottom: 1px dashed black; padding-bottom: 3mm; margin-bottom: 3mm;">
                ${dati.data}
            </div>
            
            <div style="font-size: 9pt; margin-bottom: 1mm;"><b>Operatore:</b> ${dati.operatore}</div>
            <div style="font-size: 9pt; margin-bottom: 4mm;"><b>Data Stampa:</b> ${new Date().toLocaleString('it-IT')}</div>
            
            <div style="border-bottom: 1px dashed black; margin-bottom: 2mm;"></div>
            
            <div style="display: flex; justify-content: space-between; font-size: 10pt; margin-bottom: 1mm;">
                <span>Totale Vendite Lorde:</span>
                <span>€ ${dati.lordo.toFixed(2).replace('.', ',')}</span>
            </div>
            ${dati.giftCardEmesse > 0 ? `
            <div style="display: flex; justify-content: space-between; font-size: 8.5pt; margin-bottom: 1mm; padding-left: 5mm;">
                <span>↳ di cui Emissione Gift Card (FC IVA):</span> 
                <span>€ ${dati.giftCardEmesse.toFixed(2).replace('.', ',')}</span>
            </div>
            ` : ''}
       
            <div style="display: flex; justify-content: space-between; font-size: 10pt; margin-bottom: 1mm;">
                <span>Sconti Fidelity:</span> <span>- € ${dati.sconti.toFixed(2).replace('.', ',')}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 10pt; margin-bottom: 1mm;">
                <span>Resi Merce:</span> <span>- € ${dati.resi.toFixed(2).replace('.', ',')}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 12pt; font-weight: bold; margin-top: 2mm; margin-bottom: 2mm;">
                <span>TOTALE NETTO:</span> <span>€ ${totaleNetto.toFixed(2).replace('.', ',')}</span>
            </div>

            <div style="border-bottom: 1px dashed black; margin-bottom: 2mm;"></div>
            <div style="font-weight: bold; font-size: 10pt; margin-bottom: 2mm; text-align: center;">DETTAGLIO INCASSI E METODI</div>
            
            <div style="display: flex; justify-content: space-between; font-size: 9pt; margin-bottom: 1mm;">
                <span>Contanti Vendite:</span> <span>€ ${dati.contanti.toFixed(2).replace('.', ',')}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 9pt; margin-bottom: 1mm;">
                <span>POS Elettronico:</span> <span>€ ${dati.pos.toFixed(2).replace('.', ',')}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 9pt; margin-bottom: 1mm;">
                <span>Voucher Riscattati:</span> <span>€ ${dati.voucher.toFixed(2).replace('.', ',')}</span>
            </div>
            
            <div style="border-bottom: 1px dashed black; margin-bottom: 2mm; margin-top: 2mm;"></div>
            <div style="font-weight: bold; font-size: 10pt; margin-bottom: 2mm; text-align: center;">MOVIMENTI DI CASSA (EXTRA)</div>
            
            <div style="display: flex; justify-content: space-between; font-size: 9pt; margin-bottom: 1mm;">
                <span>Entrate Extra:</span> <span>+ € ${dati.entrate.toFixed(2).replace('.', ',')}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 9pt; margin-bottom: 1mm;">
                <span>Uscite (Spese):</span> <span>- € ${dati.uscite.toFixed(2).replace('.', ',')}</span>
            </div>

            <div style="border-bottom: 1px dashed black; margin-bottom: 2mm; margin-top: 2mm;"></div>
            <div style="font-weight: bold; font-size: 10pt; margin-bottom: 2mm; text-align: center;">QUADRATURA CASSETTO</div>
            
            <div style="display: flex; justify-content: space-between; font-size: 9pt; margin-bottom: 1mm;">
                <span>Teorico Cassetto:</span> <span>€ ${dati.cassettoTeorico.toFixed(2).replace('.', ',')}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 9pt; margin-bottom: 1mm;">
                <span>Reale Dichiarato:</span> <span>€ ${dati.reale.toFixed(2).replace('.', ',')}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 11pt; font-weight: bold; margin-top: 2mm; margin-bottom: 2mm;">
                <span>DIFFERENZA:</span> <span>${dati.differenza >= 0 ? '+' : '-'} € ${Math.abs(dati.differenza).toFixed(2).replace('.', ',')}</span>
            </div>

            <div style="border-bottom: 1px dashed black; margin-bottom: 2mm;"></div>
            
            <div style="display: flex; justify-content: space-between; font-size: 9pt; margin-bottom: 1mm;">
                <span>Fondo Cassa Domani:</span> <span>€ ${dati.fondoCassa.toFixed(2).replace('.', ',')}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 11pt; font-weight: bold; margin-top: 1mm;">
                <span>DA VERSARE IN BANCA:</span> <span>€ ${dati.contantiDaVersare.toFixed(2).replace('.', ',')}</span>
            </div>
            
            <div style="border-bottom: 1px dashed black; margin-bottom: 2mm; margin-top: 2mm;"></div>
            <div style="font-weight: bold; font-size: 10pt; margin-bottom: 2mm; text-align: center;">RIEPILOGO IVA</div>
            ${ivaHtml}
            <div style="border-bottom: 1px dashed black; margin-bottom: 2mm; margin-top: 2mm;"></div>

            <div style="text-align: center; font-size: 8pt; margin-top: 5mm;">
                Documento Gestionale Interno<br>
                Z-Report Sigillato
            </div>
        </div>
    `;

    setTimeout(() => window.print(), 500);
};

// --- SOVRASCRITTURA REGOLE ANTI-ANNULLAMENTO SCONTRINI E MOVIMENTI ---
window.confermaAnnullamentoScontrino = async function (idScontrino) {
    let scontrino = await getRecordById('vendite', idScontrino);
    if (scontrino) {
        // Controlla se la data dello scontrino è già in una chiusura Z
        let tx = db.transaction('chiusure', 'readonly');
        let req = tx.objectStore('chiusure').get(scontrino.GIORNO);

        req.onsuccess = function () {
            if (req.result) {
                mostraAvvisoModale(`⚠️ <b>OPERAZIONE NEGATA</b><br><br>Impossibile annullare lo scontrino.<br>La giornata fiscale del <b>${scontrino.GIORNO}</b> è stata chiusa e sigillata con il Report Z.`);
            } else {
                // 🔥 CONTROLLO SICUREZZA ANNULLAMENTO
                if (operatoreLoggato && operatoreLoggato.ruolo === 'SALES') {
                    window.azioneInSospeso = function () {
                        idDaEliminare = idScontrino; tipoEliminazione = 'SCONTRINO';
                        document.getElementById('msg-conferma-elimina').innerHTML = "Autorizzazione concessa.<br>Sei sicuro di voler <b>ANNULLARE</b> questo scontrino?";
                        apriModale('modal-conferma-elimina');
                    };
                    document.getElementById('testo-autorizzazione').innerHTML = "L'annullamento di uno scontrino richiede l'approvazione di un Manager.";
                    document.getElementById('input-pin-admin').value = "";
                    apriModale('modal-autorizzazione');
                    return;
                }
                // Procedi normalmente con l'annullamento
                idDaEliminare = idScontrino;
                tipoEliminazione = 'SCONTRINO';
                document.getElementById('msg-conferma-elimina').innerHTML = "Sei sicuro di voler <b>ANNULLARE</b> questo scontrino?<br><br><span style='color:#b3d9ff;'>I prodotti verranno reinseriti in magazzino e i punti stornati dalla scheda del cliente.</span>";
                apriModale('modal-conferma-elimina');
            }
        };
    }
};

window.confermaAnnullamentoMovimento = async function (idMovimento, tipo) {
    let movimento = await getRecordById('movimenti_cassa', idMovimento);
    if (movimento) {
        let tx = db.transaction('chiusure', 'readonly');
        let req = tx.objectStore('chiusure').get(movimento.data);

        req.onsuccess = function () {
            if (req.result) {
                mostraAvvisoModale(`⚠️ <b>OPERAZIONE NEGATA</b><br><br>Impossibile eliminare questo movimento di cassa.<br>La giornata fiscale del <b>${movimento.data}</b> è già stata chiusa e sigillata.`);
            } else {
                idDaEliminare = idMovimento;
                tipoEliminazione = 'MOVIMENTO';
                let nomeOperazione = tipo === 'ENTRATA' ? 'questo INCASSO EXTRA' : 'questa SPESA';
                document.getElementById('msg-conferma-elimina').innerHTML = `Sei sicuro di voler <b>ELIMINARE</b> ${nomeOperazione} dal registro di cassa?`;
                apriModale('modal-conferma-elimina');
            }
        }
    }
};

window.verificaAutorizzazione = function () {
    let pinInserito = document.getElementById('input-pin-admin').value;
    let supervisore = listaOperatori.find(op => op.pin === pinInserito && (op.ruolo === 'ADMIN' || op.ruolo === 'MANAGER'));

    if (supervisore) {
        chiudiModale('modal-autorizzazione');
        registraLogSistema("OVERRIDE SUPERVISORE", `Approvazione concessa da ${supervisore.nome}`);
        if (typeof window.azioneInSospeso === 'function') {
            window.azioneInSospeso();
            window.azioneInSospeso = null;
        }
    } else {
        mostraAvvisoModale("❌ PIN non valido o privilegi insufficienti.");
        document.getElementById('input-pin-admin').value = "";
    }
};

// ==========================================
// 📂 STORICO E RISTAMPA CHIUSURE Z
// ==========================================
window.apriStoricoChiusure = function () {
    let tx = db.transaction('chiusure', 'readonly');
    let store = tx.objectStore('chiusure');
    let req = store.getAll();

    req.onsuccess = function () {
        let chiusure = req.result || [];
        // Ordina dalla chiusura più recente (invertendo le date DD/MM/YYYY per il sort)
        chiusure.sort((a, b) => new Date(b.data_chiusura.split('/').reverse().join('-')) - new Date(a.data_chiusura.split('/').reverse().join('-')));

        let tbody = document.getElementById('body-storico-chiusure');
        tbody.innerHTML = '';

        if (chiusure.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 20px; color: #888;">Nessuna chiusura presente in archivio.</td></tr>';
        } else {
            chiusure.forEach(c => {
                let tr = document.createElement('tr');
                tr.style.borderBottom = "1px solid rgba(255,255,255,0.05)";
                tr.innerHTML = `
                    <td style="padding: 10px; font-weight: bold; font-size: 2vh;">${c.data_chiusura}</td>
                    <td style="padding: 10px;">${c.operatore}</td>
                    <td style="padding: 10px; text-align: right; color: #00ffcc;">€ ${(c.lordo || 0).toLocaleString('it-IT', { minimumFractionDigits: 2 })}</td>
                    <td style="padding: 10px; text-align: right; color: #ffcc00;">€ ${(c.reale || 0).toLocaleString('it-IT', { minimumFractionDigits: 2 })}</td>
                    <td style="padding: 10px; text-align: center;">
                        <button class="btn-modal btn-blu" style="padding: 5px 15px; margin: 0; font-size: 1.2vh;" onclick="ristampaZPassata('${c.data_chiusura}')">🖨️ RISTAMPA</button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }
        apriModale('modal-storico-chiusure');
    };
};

window.ristampaZPassata = function (dataChiusura) {
    let tx = db.transaction('chiusure', 'readonly');
    let store = tx.objectStore('chiusure');
    let req = store.get(dataChiusura);

    req.onsuccess = function () {
        if (req.result) {
            // Sfruttiamo la tua funzione nativa di impaginazione e stampa!
            stampaChiusuraZ(req.result);
        } else {
            mostraAvvisoModale("Errore: chiusura non trovata nel database.");
        }
    };
};

// ==========================================
// 📋 MODULO INVENTARIO E RICONCILIAZIONE
// ==========================================

let listaInventarioAttuale = []; // Cache degli articoli filtrati
let differenzeInventario = {}; // Mappa delle modifiche in sospeso

window.apriModaleInventario = async function () {
    // 1. Recupera tutto il magazzino e popola i filtri dinamicamente
    let magazzino = await getAll('magazzino');
    let categorie = new Set();
    let brands = new Set();

    magazzino.forEach(p => {
        if (p.tipo === 'VOUCHER' || p.is_kit) return; // Escludiamo voucher e kit dinamici dall'inventario fisico
        if (p.categoria) categorie.add(p.categoria.toUpperCase());
        if (p.brand) brands.add(p.brand.toUpperCase());
        if (p.fornitore) brands.add(p.fornitore.toUpperCase());
    });

    let selCat = document.getElementById('inv-filtro-cat');
    selCat.innerHTML = '<option value="TUTTE">Tutte le Categorie</option>';
    [...categorie].sort().forEach(c => selCat.innerHTML += `<option value="${c}">${c}</option>`);

    let selBrand = document.getElementById('inv-filtro-brand');
    selBrand.innerHTML = '<option value="TUTTI">Tutti i Fornitori / Brand</option>';
    [...brands].sort().forEach(b => selBrand.innerHTML += `<option value="${b}">${b}</option>`);

    document.getElementById('inv-area-riconciliazione').style.display = 'none';

    // Chiude il magazzino e apre l'inventario
    chiudiModale('modal-magazzino');
    apriModale('modal-inventario');
};

// Funzione interna per applicare i filtri e ordinare
async function applicaFiltriInventario() {
    let magazzino = await getAll('magazzino');
    let filtroCat = document.getElementById('inv-filtro-cat').value;
    let filtroBrand = document.getElementById('inv-filtro-brand').value;
    let ordinamento = document.getElementById('inv-ordinamento').value;

    let filtrati = magazzino.filter(p => {
        if (p.tipo === 'VOUCHER' || p.is_kit) return false;
        if (filtroCat !== 'TUTTE' && (p.categoria || "").toUpperCase() !== filtroCat) return false;

        let matchBrand = (p.brand || "").toUpperCase() === filtroBrand;
        let matchFornitore = (p.fornitore || "").toUpperCase() === filtroBrand;
        if (filtroBrand !== 'TUTTI' && !matchBrand && !matchFornitore) return false;

        return true;
    });

    // Ordinamento Intelligente
    filtrati.sort((a, b) => {
        if (ordinamento === 'UBICAZIONE') {
            let ubiA = (a.ubicazione || "ZZZ").toUpperCase(); // Chi non ha ubicazione finisce in fondo
            let ubiB = (b.ubicazione || "ZZZ").toUpperCase();
            if (ubiA < ubiB) return -1;
            if (ubiA > ubiB) return 1;
            return a.descrizione.localeCompare(b.descrizione); // A parità di scaffale, ordina per nome
        } else if (ordinamento === 'CATEGORIA') {
            let catA = (a.categoria || "").toUpperCase();
            let catB = (b.categoria || "").toUpperCase();
            if (catA < catB) return -1;
            if (catA > catB) return 1;
            return a.descrizione.localeCompare(b.descrizione);
        } else {
            return a.descrizione.localeCompare(b.descrizione);
        }
    });

    return filtrati;
}

// Genera e Stampa il Foglio PDF in Orizzontale (Landscape)
window.stampaFoglioInventario = async function () {
    // 🌟 FIX: Usa la funzione nativa che estrae il magazzino e applica i filtri
    let articoli = await applicaFiltriInventario();

    if (articoli.length === 0) {
        mostraAvvisoModale("Nessun articolo trovato con questi filtri.");
        return;
    }

    let printArea = document.getElementById('print-area');
    let tbody = '';

    // Generazione della data e ora per il titolo e per il file PDF
    let dataOdierna = new Date();
    let stringaData = `${dataOdierna.getFullYear()}-${String(dataOdierna.getMonth() + 1).padStart(2, '0')}-${String(dataOdierna.getDate()).padStart(2, '0')}`;
    let stringaOra = `${String(dataOdierna.getHours()).padStart(2, '0')}-${String(dataOdierna.getMinutes()).padStart(2, '0')}`;
    let nomeFilePDF = `Inventario_Magazzino_del_${stringaData}_${stringaOra}`;

    articoli.forEach(art => {
        tbody += `
            <tr>
                <td style="padding: 8px; border: 1px solid #ccc; font-size: 10px; text-align: center;">${art.ubicazione || '-'}</td>
                <td style="padding: 8px; border: 1px solid #ccc; font-family: monospace; text-align: center;">${art.codice}</td>
                <td style="padding: 8px; border: 1px solid #ccc;"><b>${art.descrizione}</b> ${art.formato ? '(' + art.formato + ')' : ''}</td>
                <td style="padding: 8px; border: 1px solid #ccc; text-align: center;">${art.categoria || '-'}</td>
                <td style="padding: 8px; border: 1px solid #ccc; text-align: center; font-size: 14px; font-weight: bold;">${art.giacenza}</td>
                <td style="padding: 8px; border: 1px solid #ccc; text-align: center;"></td>
                <td style="padding: 8px; border: 1px solid #ccc; text-align: center;"></td>
            </tr>`;
    });

    // Inietto CSS per forzare la stampa orizzontale e l'intestazione
    printArea.innerHTML = `
        <div class="print-a4-landscape" style="color: black; font-family: Arial, sans-serif; background: white; width: 100%;">
            <style>
                @media print {
                    @page { size: A4 landscape; margin: 10mm; }
                    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                }
            </style>
            
            <div style="display: flex; justify-content: space-between; border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 20px;">
                <div>
                    <h1 style="margin: 0; font-size: 24px;">FOGLIO RICONCILIAZIONE INVENTARIO</h1>
                    <p style="margin: 10px 0 0 0; color: #555;">Filtri applicati: Cat: ${document.getElementById('inv-filtro-cat').value} | Brand: ${document.getElementById('inv-filtro-brand').value}</p>
                </div>
                <div style="text-align: right;">
                    <p style="margin: 0;"><b>Data Stampa:</b> ${dataOdierna.toLocaleString('it-IT')}</p>
                    <p style="margin: 30px 0 0 0;"><b>Operatore:</b> ___________________</p>
                </div>
            </div>

            <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                <thead>
                    <tr style="background-color: #f0f0f0;">
                        <th style="padding: 10px; border: 1px solid #ccc; text-align: center; width: 8%;">POSIZIONE</th>
                        <th style="padding: 10px; border: 1px solid #ccc; text-align: center; width: 12%;">CODICE EAN</th>
                        <th style="padding: 10px; border: 1px solid #ccc; text-align: left; width: 44%;">DESCRIZIONE ARTICOLO</th>
                        <th style="padding: 10px; border: 1px solid #ccc; text-align: center; width: 12%;">CATEGORIA</th>
                        <th style="padding: 10px; border: 1px solid #ccc; text-align: center; width: 8%;">GIACENZA SISTEMA</th>
                        <th style="padding: 10px; border: 1px solid #ccc; text-align: center; width: 8%;">Q.TÀ RILEVATA</th>
                        <th style="padding: 10px; border: 1px solid #ccc; text-align: center; width: 8%;">CHECK (✓)</th>
                    </tr>
                </thead>
                <tbody>${tbody}</tbody>
            </table>
        </div>
    `;

    printArea.style.display = 'block';

    // Nasconde l'interfaccia dell'app per stampare solo il foglio
    let bodyChildren = document.body.children;
    for (let i = 0; i < bodyChildren.length; i++) {
        if (bodyChildren[i].id !== 'print-area' && bodyChildren[i].tagName !== 'SCRIPT') {
            bodyChildren[i].dataset.display = bodyChildren[i].style.display;
            bodyChildren[i].style.display = 'none';
        }
    }

    // 🔥 CAMBIO TEMPORANEO DEL NOME DELLA PAGINA PER FORZARE IL NOME DEL PDF
    let titoloOriginale = document.title;
    document.title = nomeFilePDF;

    // Lancia la finestra di stampa del dispositivo
    window.print();

    // Ripristino dell'interfaccia originale e del titolo
    document.title = titoloOriginale;
    printArea.style.display = 'none';
    printArea.innerHTML = '';

    for (let i = 0; i < bodyChildren.length; i++) {
        if (bodyChildren[i].id !== 'print-area' && bodyChildren[i].tagName !== 'SCRIPT') {
            bodyChildren[i].style.display = bodyChildren[i].dataset.display || '';
        }
    }
};

// Avvia la Maschera di Riconciliazione
window.avviaRiconciliazione = async function () {
    listaInventarioAttuale = await applicaFiltriInventario();
    differenzeInventario = {}; // Azzera i calcoli

    if (listaInventarioAttuale.length === 0) {
        mostraAvvisoModale("Nessun articolo trovato con questi filtri.");
        return;
    }

    disegnaTabellaRiconciliazione();
    document.getElementById('inv-area-riconciliazione').style.display = 'flex';
};

function disegnaTabellaRiconciliazione() {
    let tbody = document.getElementById('body-riconciliazione');
    tbody.innerHTML = '';

    listaInventarioAttuale.forEach((art, idx) => {
        let tr = document.createElement('tr');
        tr.id = `inv-row-${idx}`;
        tr.style.borderBottom = "1px solid rgba(255,255,255,0.05)";

        tr.innerHTML = `
            <td style="padding: 8px; color: #b3d9ff;">${art.ubicazione || '-'}</td>
            <td style="padding: 8px; font-family: monospace; color: #888;">${art.codice}</td>
            <td style="padding: 8px; font-weight: bold;">${art.descrizione}</td>
            <td style="padding: 8px; text-align: center; color: #888; font-size: 2vh;">${art.giacenza}</td>
            <td style="padding: 8px; text-align: center;">
                <input type="number" value="${art.giacenza}" min="0" class="crm-input" style="width: 80px; text-align: center; font-size: 2vh; font-weight: bold; margin: 0; padding: 5px;" onchange="calcolaRigaInventario(${idx}, this.value)">
            </td>
            <td style="padding: 8px; text-align: center; font-weight: bold;" id="inv-diff-${idx}">-</td>
        `;
        tbody.appendChild(tr);
    });

    aggiornaTotaleDifferenzaInventario();
}

window.calcolaRigaInventario = function (idx, nuovaQtaStr) {
    let art = listaInventarioAttuale[idx];
    let nuovaQta = parseInt(nuovaQtaStr);

    if (isNaN(nuovaQta) || nuovaQta < 0) return;

    let riga = document.getElementById(`inv-row-${idx}`);
    let cellaDiff = document.getElementById(`inv-diff-${idx}`);

    let differenzaPezzi = nuovaQta - art.giacenza;

    if (differenzaPezzi !== 0) {
        // Salva la modifica in sospeso
        differenzeInventario[art.codice] = {
            articolo: art,
            nuovaQta: nuovaQta,
            differenzaPezzi: differenzaPezzi,
            valoreEconomico: differenzaPezzi * (art.prezzoAcquisto || 0) // Usa il costo di acquisto!
        };

        riga.style.backgroundColor = "rgba(255, 204, 0, 0.2)"; // Evidenzia di Giallo le righe modificate

        let segno = differenzaPezzi > 0 ? "+" : "";
        let coloreVal = differenzaPezzi > 0 ? "#00cc66" : "#ff4d4d"; // Verde se trovi roba, Rosso se la perdi
        cellaDiff.innerHTML = `<span style="color: ${coloreVal};">${segno}€ ${differenzeInventario[art.codice].valoreEconomico.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</span>`;
    } else {
        // Se l'utente rimette il valore originale, annulla la modifica
        delete differenzeInventario[art.codice];
        riga.style.backgroundColor = "transparent";
        cellaDiff.innerHTML = "-";
    }

    aggiornaTotaleDifferenzaInventario();
};

function aggiornaTotaleDifferenzaInventario() {
    let totalePersoOGuadagnato = 0;

    for (let cod in differenzeInventario) {
        totalePersoOGuadagnato += differenzeInventario[cod].valoreEconomico;
    }

    let divTotale = document.getElementById('inv-diff-valore');
    let segno = totalePersoOGuadagnato > 0 ? "+" : "";

    divTotale.textContent = `${segno}€ ${totalePersoOGuadagnato.toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;

    if (totalePersoOGuadagnato < 0) {
        divTotale.style.color = "#ff4d4d"; // Perdita inventariale
    } else if (totalePersoOGuadagnato > 0) {
        divTotale.style.color = "#00cc66"; // Merce trovata in più
    } else {
        divTotale.style.color = "white";
    }
}

window.confermaSalvataggioRiconciliazione = async function () {
    let chiaviModificate = Object.keys(differenzeInventario);

    if (chiaviModificate.length === 0) {
        mostraAvvisoModale("Nessuna quantità è stata modificata. Non c'è nulla da salvare.");
        return;
    }

    let totaleEconomico = parseFloat(document.getElementById('inv-diff-valore').textContent.replace(/[^0-9.,\-+]/g, '').replace(',', '.'));

    let conferma = confirm(`Stai per rettificare ${chiaviModificate.length} articoli.\n\nDifferenza Economica Totale: € ${totaleEconomico.toFixed(2)}\n\nConfermi l'aggiornamento definitivo del magazzino?`);
    if (!conferma) return;

    let txMag = db.transaction('magazzino', 'readwrite');
    let storeMag = txMag.objectStore('magazzino');

    // Manteniamo traccia della rettifica anche nel registro movimenti per la contabilità generale
    let noteMovimento = `Rettifica Inventario: modificati ${chiaviModificate.length} articoli.`;
    let tipoMovimento = totaleEconomico < 0 ? "USCITA" : "ENTRATA"; // Se è < 0 è una perdita (Uscita)
    let importoMovimento = Math.abs(totaleEconomico);

    chiaviModificate.forEach(codice => {
        let mod = differenzeInventario[codice];
        let p = mod.articolo;

        p.giacenza = mod.nuovaQta;

        // Crea il Log di Rettifica all'interno dell'articolo stesso
        if (!p.log_inventario) p.log_inventario = [];
        p.log_inventario.push({
            data: getOggiString(),
            ora: `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`,
            operatore: operatoreAttivo,
            causale: "Rettifica da Inventario Manuale",
            qta_precedente: p.giacenza - mod.differenzaPezzi,
            qta_nuova: mod.nuovaQta,
            differenza_valore: mod.valoreEconomico
        });

        storeMag.put(p);

        // Invia aggiornamento a Firebase
        if (typeof salvaProdottoCloud === "function") salvaProdottoCloud(p);
    });

    txMag.oncomplete = async function () {
        // Registriamo il movimento economico (se c'è una discrepanza)
        if (importoMovimento > 0) {
            let d = new Date();
            let nuovoMovimento = {
                data: getOggiString(),
                ora: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
                tipo: tipoMovimento,
                importo: importoMovimento,
                descrizione: noteMovimento
            };
            await salvaMovimentoCassaDB(nuovoMovimento);
            if (typeof inviaMovimentoLive === "function") inviaMovimentoLive(nuovoMovimento);
        }

        mostraAvvisoModale(`✅ <b>INVENTARIO AGGIORNATO</b><br><br>Le giacenze di ${chiaviModificate.length} articoli sono state allineate.<br>Le differenze sono state registrate nel log dell'operatore: <b>${operatoreAttivo}</b>.`);

        chiudiModale('modal-inventario');
        apriModale('modal-magazzino');
        // Ricarica la lista del magazzino per mostrare le nuove quantità
        if (typeof magCaricaLista === "function") magCaricaLista();
    };
};

// ==========================================
// 📜 VISUALIZZAZIONE LOG RETTIFICHE INVENTARIO
// ==========================================

window.apriStoricoRettifiche = async function () {
    let codice = document.getElementById('mag-codice').value.trim();

    // Controlla se l'articolo è già stato salvato nel database
    if (!codice || document.getElementById('mag-codice').disabled === false) {
        mostraAvvisoModale("Devi prima salvare o selezionare un articolo per visualizzarne lo storico delle rettifiche.");
        return;
    }

    let p = await getProdottoDaMagazzino(codice);
    if (!p) {
        mostraAvvisoModale("Articolo non trovato nel database.");
        return;
    }

    // Intesta la modale con il nome del prodotto
    document.getElementById('log-ret-articolo').textContent = `[${p.codice}] ${p.descrizione}`;

    let tbody = document.getElementById('body-storico-rettifiche');
    tbody.innerHTML = '';

    // Controlla se esiste l'array del log
    if (!p.log_inventario || p.log_inventario.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 20px; color: #888;">Nessuna rettifica manuale registrata per questo articolo.</td></tr>';
    } else {
        // Clona l'array e lo inverte per mostrare le modifiche più recenti in cima
        let logOrdinato = [...p.log_inventario].reverse();

        logOrdinato.forEach(log => {
            let tr = document.createElement('tr');
            tr.style.borderBottom = "1px solid rgba(255,255,255,0.05)";

            let diffEconomica = log.differenza_valore || 0;
            let coloreDiff = diffEconomica > 0 ? '#00cc66' : (diffEconomica < 0 ? '#ff4d4d' : 'white');
            let segno = diffEconomica > 0 ? '+' : '';

            tr.innerHTML = `
                <td style="padding: 8px;">${log.data} <span style="color:#888; font-size: 1.4vh;">${log.ora}</span></td>
                <td style="padding: 8px; color: #b3d9ff;">👤 ${log.operatore || 'Sconosciuto'}</td>
                <td style="padding: 8px; text-align: center; color: #888; text-decoration: line-through;">${log.qta_precedente}</td>
                <td style="padding: 8px; text-align: center; font-weight: bold; color: #ffcc00; font-size: 2vh;">${log.qta_nuova}</td>
                <td style="padding: 8px; text-align: right; color: ${coloreDiff}; font-weight: bold;">${segno}€ ${Math.abs(diffEconomica).toLocaleString('it-IT', { minimumFractionDigits: 2 })}</td>
            `;
            tbody.appendChild(tr);
        });
    }

    apriModale('modal-storico-rettifiche');
};

// ==========================================
// ☁️ SINCRONIZZAZIONE CLOUD: VOUCHER E ORDINI
// ==========================================

window.salvaVoucherCloud = async function (voucher) {
    if (!FIREBASE_URL || !navigator.onLine) return;
    try {
        await fetch(`${FIREBASE_URL}/vouchers/${voucher.codice}.json`, {
            method: 'PUT',
            body: JSON.stringify(voucher)
        });
    } catch (e) { console.error("Errore salvataggio voucher cloud:", e); }
};

window.eliminaVoucherCloud = async function (codice) {
    if (!FIREBASE_URL || !navigator.onLine) return;
    try {
        await fetch(`${FIREBASE_URL}/vouchers/${codice}.json`, { method: 'DELETE' });
    } catch (e) { console.error("Errore eliminazione voucher cloud:", e); }
};

window.scaricaVouchersDalCloud = async function () {
    if (!FIREBASE_URL) return;
    try {
        let res = await fetch(`${FIREBASE_URL}/vouchers.json`);
        let data = await res.json();
        if (data) {
            let tx = db.transaction('vouchers', 'readwrite');
            let store = tx.objectStore('vouchers');
            for (let key in data) { store.put(data[key]); }
        }
    } catch (e) { console.error("Errore download vouchers:", e); }
};

window.salvaOrdineCloud = async function (ordine) {
    if (!FIREBASE_URL || !navigator.onLine) return;
    try {
        await fetch(`${FIREBASE_URL}/ordini/${ordine.id_ordine}.json`, {
            method: 'PUT',
            body: JSON.stringify(ordine)
        });
    } catch (e) { console.error("Errore salvataggio ordine cloud:", e); }
};

window.eliminaOrdineCloud = async function (id_ordine) {
    if (!FIREBASE_URL || !navigator.onLine) return;
    try {
        await fetch(`${FIREBASE_URL}/ordini/${id_ordine}.json`, { method: 'DELETE' });
    } catch (e) { console.error("Errore eliminazione ordine cloud:", e); }
};

window.scaricaOrdiniDalCloud = async function () {
    if (!FIREBASE_URL) return;
    try {
        let res = await fetch(`${FIREBASE_URL}/ordini.json`);
        let data = await res.json();
        if (data) {
            let tx = db.transaction('ordini', 'readwrite');
            let store = tx.objectStore('ordini');
            for (let key in data) { store.put(data[key]); }
        }
    } catch (e) { console.error("Errore download ordini:", e); }
};

// ==========================================
// ⚙️ GESTIONE CATEGORIE DINAMICHE
// ==========================================

// Inizializza le categorie se non esistono
function getCategorieMagazzino() {
    let cat = localStorage.getItem('gestionale_categorie');
    if (cat) return JSON.parse(cat);
    return ["PROFUMERIA", "COSMETICA", "MAKE-UP", "GADGET", "VARIE"]; // Valori di default
}

function salvaCategorieMagazzino(cats) {
    localStorage.setItem('gestionale_categorie', JSON.stringify(cats));
}

// Popola le select nei moduli Magazzino e Soglie Punti
window.popolaSelectCategorie = function () {
    let cats = getCategorieMagazzino();
    let selectMag = document.getElementById('mag-categoria');
    let selectSoglie = document.getElementById('nuova-soglia-cat');

    if (selectMag) {
        let valAttuale = selectMag.value;
        selectMag.innerHTML = '';
        cats.forEach(c => {
            let opt = document.createElement('option');
            opt.value = c; opt.textContent = c;
            selectMag.appendChild(opt);
        });
        if (cats.includes(valAttuale)) selectMag.value = valAttuale; // Mantiene la selezione
    }

    if (selectSoglie) {
        selectSoglie.innerHTML = '<option value="">-- Scegli Categoria --</option>';
        cats.forEach(c => {
            let opt = document.createElement('option');
            opt.value = c; opt.textContent = c;
            selectSoglie.appendChild(opt);
        });
    }
};

window.apriModaleGestioneCategorie = function () {
    disegnaListaCategorie();
    apriModale('modal-gestione-categorie');
};

window.disegnaListaCategorie = function () {
    let cats = getCategorieMagazzino();
    let container = document.getElementById('lista-categorie-gestione');
    container.innerHTML = '';

    cats.forEach(c => {
        let div = document.createElement('div');
        div.style = "display: flex; justify-content: space-between; align-items: center; padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.1);";
        div.innerHTML = `
            <span style="color: white; font-size: 1.8vh;">${c}</span>
            <button class="btn-modal btn-rosso" style="padding: 5px 10px; margin: 0; font-size: 1.2vh;" onclick="eliminaCategoria('${c}')">❌</button>
        `;
        container.appendChild(div);
    });
};

window.aggiungiCategoria = function () {
    let input = document.getElementById('input-nuova-categoria');
    let val = input.value.trim().toUpperCase();
    if (!val) return;

    let cats = getCategorieMagazzino();
    if (!cats.includes(val)) {
        cats.push(val);
        salvaCategorieMagazzino(cats);
        input.value = '';
        disegnaListaCategorie();
        popolaSelectCategorie();
    } else {
        mostraAvvisoModale("Questa categoria è già presente nell'elenco.");
    }
};

window.eliminaCategoria = function (cat) {
    let cats = getCategorieMagazzino();
    cats = cats.filter(c => c !== cat);
    salvaCategorieMagazzino(cats);
    disegnaListaCategorie();
    popolaSelectCategorie();
};

// ==========================================
// 🎁 MODULO GIFT CARD (EMISSIONE E STAMPA)
// ==========================================
window.apriModaleEmissioneGiftCard = function () {
    document.getElementById('input-importo-giftcard').value = '';
    apriModale('modal-emissione-giftcard');
    setTimeout(() => document.getElementById('input-importo-giftcard').focus(), 100);
};

window.aggiungiGiftCardAlCarrello = function () {
    let inputVal = document.getElementById('input-importo-giftcard').value.replace(',', '.');
    let importo = parseFloat(inputVal);

    if (isNaN(importo) || importo <= 0) {
        mostraAvvisoModale("Inserisci un importo valido.");
        return;
    }

    let codiceGC = "GC" + Math.floor(10000000 + Math.random() * 90000000); // Es. GC12345678

    // Utilizziamo la funzione nativa del tuo gestionale per aggiungere e disegnare la riga!
    aggiungiProdotto({
        codice: codiceGC,
        descrizione: "GIFT CARD PREPAGATA",
        giacenza: "-",
        prezzo: importo,
        categoria: "GIFT_CARD",
        is_giftcard: true,
        iva: 0,
        tipo: "PZ"
    });

    chiudiModale('modal-emissione-giftcard');
};

function getScadenzaGiftCard() {
    let d = new Date();
    d.setFullYear(d.getFullYear() + 1); // Validità 12 mesi
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

window.stampaTicketGiftCard = function (gc) {
    let printArea = document.getElementById('print-area');

    printArea.innerHTML = `
        <div class="print-ticket" style="color: black; font-family: monospace; background: white; text-align: center; padding: 10px 0;">
            <div style="font-size: 18pt; font-weight: bold; margin-bottom: 2mm;">🎁 GIFT CARD</div>
            <div style="font-size: 10pt; margin-bottom: 5mm;">BUONO REGALO PREPAGATO</div>
            
            <svg id="barcode-gc"></svg>
            
            <div style="font-size: 14pt; font-weight: bold; margin-top: 5mm; margin-bottom: 2mm;">VALORE: € ${gc.importoIniziale.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
            
            <div style="border-bottom: 1px dashed black; margin: 3mm 0;"></div>
            
            <div style="font-size: 9pt; text-align: left; padding: 0 5mm;">
                <div><b>Emissione:</b> ${gc.dataEmissione}</div>
                <div><b>Scadenza:</b> ${gc.scadenza}</div>
                <div style="margin-top: 3mm;">Da conservare con cura. Utilizzabile per acquisti parziali o totali fino ad esaurimento del credito. Non rimborsabile in contanti.</div>
            </div>
            
            <div style="border-bottom: 1px dashed black; margin: 3mm 0;"></div>
            <div style="font-size: 8pt; margin-top: 2mm;">Grazie e a presto!</div>
        </div>
    `;

    JsBarcode("#barcode-gc", gc.codice, {
        format: "CODE128", width: 2, height: 60, displayValue: true, fontSize: 16, margin: 10
    });

    setTimeout(() => window.print(), 500);
};

// ==========================================
// 💳 REPORT FINANZIARIO DEBITI GIFT CARD
// ==========================================
window.apriReportGiftCard = async function () {
    let giftcards = await getAll('giftcards');
    let tbody = document.getElementById('body-report-giftcard');
    tbody.innerHTML = '';

    let numAttive = 0;
    let totDebito = 0;

    // Ordina dalla più recente alla più vecchia
    giftcards.sort((a, b) => new Date(b.dataEmissione.split('/').reverse().join('-')) - new Date(a.dataEmissione.split('/').reverse().join('-')));

    giftcards.forEach(gc => {
        if (gc.stato === 'ATTIVA' && gc.saldo > 0) {
            numAttive++;
            totDebito += gc.saldo;
        }

        let coloreStato = gc.stato === 'ATTIVA' ? '#00cc66' : '#ff4d4d';
        let tr = document.createElement('tr');
        tr.style.borderBottom = "1px solid rgba(255,255,255,0.05)";
        tr.innerHTML = `
            <td style="padding: 10px; font-weight: bold;">${gc.codice}</td>
            <td style="padding: 10px;">${gc.dataEmissione}</td>
            <td style="padding: 10px; text-align: right;">€ ${gc.importoIniziale.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</td>
            <td style="padding: 10px; text-align: right; color: #ffcc00; font-weight: bold;">€ ${gc.saldo.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</td>
            <td style="padding: 10px; text-align: center; color: ${coloreStato};">${gc.stato}</td>
        `;
        tbody.appendChild(tr);
    });

    document.getElementById('report-gc-attive').textContent = numAttive;
    document.getElementById('report-gc-debito').textContent = '€ ' + totDebito.toLocaleString('it-IT', { minimumFractionDigits: 2 });

    apriModale('modal-report-giftcard');
};

// ==========================================
// 💳 DASHBOARD E VERIFICA GIFT CARD (ADVANCED)
// ==========================================
let cacheGiftCards = [];
let gcApertaInDettaglio = null;

window.apriGestioneGiftCard = async function () {
    cacheGiftCards = await getAll('giftcards');
    // Ordina dalla più recente
    cacheGiftCards.sort((a, b) => new Date(b.dataEmissione.split('/').reverse().join('-')) - new Date(a.dataEmissione.split('/').reverse().join('-')));

    document.getElementById('filtro-stato-gc').value = 'TUTTE';
    document.getElementById('filtro-ricerca-gc').value = '';
    document.getElementById('input-verifica-gc').value = '';

    // Rimuoviamo la vecchia funzione base (se presente) per usare la nuova Dashboard
    chiudiModale('modal-report-giftcard');
    chiudiModale('modal-menu-principale');

    filtraDashboardGiftCard();
    apriModale('modal-dashboard-giftcard');
    setTimeout(() => document.getElementById('input-verifica-gc').focus(), 100);
};

window.filtraDashboardGiftCard = async function () {
    let vouchers = await getAll('vouchers');

    // Recupera i valori dai filtri
    let statoScelto = document.getElementById('filtro-stato-gc').value;
    let tipoScelto = document.getElementById('filtro-tipo-gc') ? document.getElementById('filtro-tipo-gc').value : "TUTTI";
    let testoRicerca = document.getElementById('filtro-ricerca-gc').value.toLowerCase().trim();

    let tbody = document.getElementById('body-dashboard-gc');
    tbody.innerHTML = '';

    let totaliAttive = 0;
    let debitoTotale = 0;

    // Ordinamento: dal più recente al più vecchio
    vouchers.sort((a, b) => new Date(b.data_emissione) - new Date(a.data_emissione));

    vouchers.forEach(v => {
        let isAttiva = v.saldo > 0;
        let statoTesto = isAttiva ? "ATTIVA" : "ESAURITA";
        let statoColore = isAttiva ? "#00cc66" : "#888";

        // Determina se è un reso o una gift card (supporta diverse chiavi di salvataggio)
        let isReso = v.is_reso === true || v.tipo === 'RESO' || (v.motivo && v.motivo.toLowerCase().includes('reso'));
        let iconaTipo = isReso ? "🔄 Buono Reso" : "🎁 Gift Card";

        // 1. Filtro Tipo (Gift Card vs Reso)
        if (tipoScelto === "GIFT_CARD" && isReso) return;
        if (tipoScelto === "RESO" && !isReso) return;

        // 2. Filtro Stato (Attiva vs Esaurita)
        if (statoScelto === "ATTIVA" && !isAttiva) return;
        if (statoScelto === "ESAURITA" && isAttiva) return;

        // 3. Filtro Testuale Libero
        if (testoRicerca !== "") {
            let stringaRicerca = `${v.codice} ${v.valore_iniziale} ${v.saldo}`.toLowerCase();
            if (!stringaRicerca.includes(testoRicerca)) return;
        }

        // Calcolo per il box riepilogativo in alto
        if (isAttiva) {
            totaliAttive++;
            debitoTotale += parseFloat(v.saldo);
        }

        let tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid rgba(255,255,255,0.1)';

        tr.innerHTML = `
            <td style="padding: 15px 10px; font-family: monospace; font-size: 2vh; color: #ffcc00; font-weight: bold;">
                ${v.codice}<br>
                <span style="font-family: sans-serif; font-size: 1.2vh; color: #b3d9ff;">${iconaTipo}</span>
            </td>
            <td style="padding: 15px 10px;">${v.data_emissione || "N/D"}</td>
            <td style="padding: 15px 10px;">Senza Scadenza</td>
            <td style="padding: 15px 10px; text-align: right;">€ ${parseFloat(v.valore_iniziale || 0).toLocaleString('it-IT', { minimumFractionDigits: 2 })}</td>
            <td style="padding: 15px 10px; text-align: right; color: ${statoColore}; font-weight: bold;">€ ${parseFloat(v.saldo || 0).toLocaleString('it-IT', { minimumFractionDigits: 2 })}</td>
            <td style="padding: 15px 10px; text-align: center; color: ${statoColore}; font-weight: bold;">${statoTesto}</td>
            <td style="padding: 15px 10px; text-align: center;">
                <button class="btn-modal btn-blu" style="padding: 5px 10px; margin: 0; font-size: 1.2vh;" onclick="verificaRapidaGiftCard('${v.codice}')">🔍 DETTAGLIO</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    // Aggiorna le statistiche in cima alla pagina
    document.getElementById('dash-gc-attive').innerText = totaliAttive;
    document.getElementById('dash-gc-debito').innerText = '€ ' + debitoTotale.toLocaleString('it-IT', { minimumFractionDigits: 2 });
};

// =======================================================
// 💰 CONTABILIZZAZIONE SOPRAVVENIENZA ATTIVA (GC SCADUTE)
// =======================================================
window.contabilizzaSopravvenienzaGC = async function (codice, saldo) {
    let conferma = confirm(`Vuoi contabilizzare € ${saldo.toFixed(2)} come "Sopravvenienza Attiva" e chiudere definitivamente la Gift Card ${codice}?\n\nQuesta operazione creerà un'Entrata di Cassa nel registro di oggi per allineare i conti col Fisco.`);
    if (!conferma) return;

    let d = new Date();
    let hh = String(d.getHours()).padStart(2, '0');
    let min = String(d.getMinutes()).padStart(2, '0');

    // 1. Crea Entrata nel Registro (così finisce nel Report Z come incasso extra senza IVA)
    let nuovoMovimento = {
        data: getOggiString(),
        ora: `${hh}:${min}`,
        tipo: "ENTRATA",
        importo: saldo,
        descrizione: `Sopravvenienza Attiva (Scadenza GC ${codice})`
    };
    nuovoMovimento.id = await salvaMovimentoCassaDB(nuovoMovimento);
    if (typeof inviaMovimentoLive === "function") inviaMovimentoLive(nuovoMovimento);

    // 2. Azzera il debito e chiudi la Gift Card
    let gc = await getRecordById('giftcards', codice);
    if (gc) {
        gc.saldo = 0;
        gc.stato = "ESAURITA";

        if (!gc.storico) gc.storico = [];
        gc.storico.push({
            data: getOggiString(),
            ora: `${hh}:${min}`,
            importo: -saldo,
            tipo: "SCADENZA FISCALE"
        });

        let tx = db.transaction('giftcards', 'readwrite');
        tx.objectStore('giftcards').put(gc);
        if (typeof salvaGiftCardCloud === "function") salvaGiftCardCloud(gc);
    }

    mostraAvvisoModale(`Operazione completata!<br>La Gift Card è stata chiusa e i <b>€ ${saldo.toFixed(2)}</b> sono stati registrati come ricavo.`);
    apriGestioneGiftCard(); // Ricarica la dashboard
};

window.verificaRapidaGiftCard = async function (codiceInput) {
    let codice = codiceInput.trim().toUpperCase();
    if (!codice) return;

    let gc = await getRecordById('giftcards', codice);
    if (gc) {
        gcApertaInDettaglio = gc;
        document.getElementById('input-verifica-gc').value = '';

        document.getElementById('det-gc-codice').textContent = gc.codice;
        document.getElementById('det-gc-saldo').textContent = `€ ${gc.saldo.toLocaleString('it-IT', { minimumFractionDigits: 2 })}`;
        document.getElementById('det-gc-em').textContent = gc.dataEmissione;
        document.getElementById('det-gc-sc').textContent = gc.scadenza;

        let partiScadenza = gc.scadenza.split('/');
        let dataScadenza = new Date(partiScadenza[2], parseInt(partiScadenza[1]) - 1, partiScadenza[0]);
        let oggi = new Date(); oggi.setHours(0, 0, 0, 0);
        let diffGiorni = Math.ceil((dataScadenza - oggi) / (1000 * 60 * 60 * 24));

        let statoLabel = document.getElementById('det-gc-stato');
        if (gc.saldo <= 0) { statoLabel.textContent = "ESAURITA"; statoLabel.style.color = "#888"; }
        else if (diffGiorni < 0) { statoLabel.textContent = "SCADUTA"; statoLabel.style.color = "#ff4d4d"; }
        else { statoLabel.textContent = "ATTIVA"; statoLabel.style.color = "#00cc66"; }

        // Disegna lo Storico
        let htmlStorico = "";
        if (!gc.storico || gc.storico.length === 0) {
            htmlStorico = "<div style='color:#888; text-align:center;'>Nessun movimento registrato.</div>";
        } else {
            // Invertiamo l'array per mostrare il più recente in cima
            let storicoInverso = [...gc.storico].reverse();
            storicoInverso.forEach(st => {
                let segno = st.importo < 0 ? "" : "+"; // Il meno è già nel numero se negativo
                let coloreVal = st.importo < 0 ? "#ff6666" : "#00cc66";
                htmlStorico += `
                    <div style="display:flex; justify-content:space-between; border-bottom:1px solid rgba(255,255,255,0.05); padding: 4px 0;">
                        <span>${st.data} - ${st.ora}</span>
                        <span>${st.tipo}</span>
                        <span style="color: ${coloreVal}; font-weight:bold;">${segno}€ ${st.importo.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</span>
                    </div>`;
            });
        }
        document.getElementById('det-gc-storico').innerHTML = htmlStorico;
        document.getElementById('input-ricarica-gc').value = '';

        apriModale('modal-dettaglio-gc');
    } else {
        mostraAvvisoModale(`Nessuna Gift Card trovata con il codice <b>${codice}</b>`);
        document.getElementById('input-verifica-gc').value = '';
    }
};

window.inviaRicaricaInCassa = function () {
    if (!gcApertaInDettaglio) return;

    let importoStr = document.getElementById('input-ricarica-gc').value.replace(',', '.');
    let importo = parseFloat(importoStr);

    if (isNaN(importo) || importo <= 0) {
        mostraAvvisoModale("Inserisci un importo valido per la ricarica.");
        return;
    }

    // Inseriamo l'articolo speciale nel carrello della cassa!
    aggiungiProdotto({
        codice: "RIC-" + Math.floor(100000 + Math.random() * 900000), // Codice fittizio per lo scontrino
        codice_gc_originale: gcApertaInDettaglio.codice, // Memorizziamo quale card ricaricare!
        descrizione: `RICARICA GIFT CARD [${gcApertaInDettaglio.codice}]`,
        giacenza: "-",
        prezzo: importo,
        categoria: "GIFT_CARD_RIC",
        is_giftcard_ricarica: true,
        iva: 0,
        tipo: "PZ"
    });

    chiudiModale('modal-dettaglio-gc');
    chiudiModale('modal-dashboard-giftcard');
    mostraAvvisoModale(`<b>RICARICA PRONTA IN CASSA</b><br><br>L'importo di € ${importo.toFixed(2).replace('.', ',')} è stato aggiunto allo scontrino corrente. Procedi al pagamento per rendere effettivo il credito sulla carta fisica.`);
};

window.stampaPromemoriaGC = function () {
    if (!gcApertaInDettaglio) return;
    let gc = gcApertaInDettaglio;

    let printArea = document.getElementById('print-area');
    printArea.innerHTML = `
        <div class="print-ticket" style="color: black; font-family: monospace; background: white; text-align: center; padding: 10px 0;">
            <div style="font-size: 14pt; font-weight: bold; margin-bottom: 2mm;">PROMEMORIA SALDO</div>
            <div style="font-size: 10pt; margin-bottom: 5mm;">GIFT CARD PREPAGATA</div>
            
            <div style="font-size: 12pt; font-weight: bold; letter-spacing: 2px;">${gc.codice}</div>
            
            <div style="font-size: 16pt; font-weight: bold; margin-top: 5mm; margin-bottom: 2mm; color: #000;">SALDO: € ${gc.saldo.toLocaleString('it-IT', { minimumFractionDigits: 2 })}</div>
            
            <div style="border-bottom: 1px dashed black; margin: 3mm 0;"></div>
            
            <div style="font-size: 9pt; text-align: left; padding: 0 5mm;">
                <div><b>Data Verifica:</b> ${getOggiString()}</div>
                <div><b>Data Scadenza:</b> ${gc.scadenza}</div>
                <div style="margin-top: 3mm;">Conserva questo promemoria insieme alla tua tessera regalo.</div>
            </div>
            <div style="border-bottom: 1px dashed black; margin: 3mm 0;"></div>
        </div>
    `;

    setTimeout(() => window.print(), 500);
};

// ==========================================
// 👥 MODULO GESTIONE OPERATORI (CRUD CON MODIFICA)
// ==========================================

let idOperatoreInModifica = null; // Variabile globale per ricordare chi stiamo modificando

window.apriGestioneOperatori = function () {
    if (operatoreLoggato && operatoreLoggato.ruolo !== 'ADMIN') {
        mostraAvvisoModale("⚠️ <b>Accesso Negato</b><br><br>Solo il Titolare (ruolo ADMIN) è autorizzato ad aggiungere o modificare i dipendenti dal gestionale.");
        return;
    }

    chiudiModale('modal-impostazioni-menu');
    annullaModificaOperatore(); // Pulisce il form ogni volta che lo apriamo
    disegnaListaOperatori();
    apriModale('modal-gestione-operatori');
};

// Autocompleta lo sconto logico in base al ruolo scelto
window.impostaScontoDefaultRuolo = function () {
    let ruolo = document.getElementById('op-nuovo-ruolo').value;
    let inputSconto = document.getElementById('op-nuovo-sconto');
    if (ruolo === 'ADMIN') inputSconto.value = '100';
    else if (ruolo === 'MANAGER') inputSconto.value = '15';
    else inputSconto.value = '5';
};

window.disegnaListaOperatori = function () {
    let container = document.getElementById('lista-operatori-attivi');
    container.innerHTML = '';

    listaOperatori.forEach(op => {
        let coloreRuolo = op.ruolo === 'ADMIN' ? '#ff4d4d' : (op.ruolo === 'MANAGER' ? '#ffcc00' : '#00cc66');
        let iconaRuolo = op.ruolo === 'ADMIN' ? '👑' : (op.ruolo === 'MANAGER' ? '👔' : '👤');

        container.innerHTML += `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 10px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                <div>
                    <b style="font-size: 1.8vh; color: white;">${iconaRuolo} ${op.nome}</b><br>
                    <span style="font-size: 1.3vh; color: ${coloreRuolo}; font-weight: bold; background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px;">${op.ruolo}</span> 
                    <span style="font-size: 1.3vh; color: #888; margin-left: 5px;">| Sconto Max: ${op.max_sconto}%</span>
                </div>
                <div style="display: flex; gap: 5px;">
                    <button class="btn-modal btn-blu" style="padding: 6px 12px; margin: 0; font-size: 1.4vh;" onclick="preparaModificaOperatore(${op.id})" title="Modifica">✏️</button>
                    <button class="btn-modal btn-rosso" style="padding: 6px 12px; margin: 0; font-size: 1.4vh;" onclick="confermaEliminazioneOperatore(${op.id}, '${op.nome.replace(/'/g, "\\'")}')" title="Elimina">🗑️</button>
                </div>
            </div>
        `;
    });
};

// Carica i dati dell'operatore nel form
window.preparaModificaOperatore = function (id) {
    let op = listaOperatori.find(o => o.id === id);
    if (!op) return;

    idOperatoreInModifica = id;

    document.getElementById('op-nuovo-nome').value = op.nome;
    document.getElementById('op-nuovo-pin').value = op.pin;
    document.getElementById('op-nuovo-ruolo').value = op.ruolo;
    document.getElementById('op-nuovo-sconto').value = op.max_sconto;

    // Aggiorna la veste grafica del modulo
    document.getElementById('titolo-form-operatore').innerHTML = "✏️ Modifica Dipendente";
    document.getElementById('titolo-form-operatore').style.color = "#ffcc00";
    document.getElementById('btn-salva-operatore').innerHTML = "💾 SALVA MODIFICHE";
    document.getElementById('btn-salva-operatore').style.background = "#ffcc00";
    document.getElementById('btn-salva-operatore').style.color = "#000";
    document.getElementById('btn-annulla-modifica-op').style.display = "block";
};

// Svuota i campi e torna alla modalità "Nuovo"
window.annullaModificaOperatore = function () {
    idOperatoreInModifica = null;
    document.getElementById('op-nuovo-nome').value = '';
    document.getElementById('op-nuovo-pin').value = '';
    document.getElementById('op-nuovo-ruolo').value = 'SALES';
    document.getElementById('op-nuovo-sconto').value = '5';

    // Ripristina grafica originale
    document.getElementById('titolo-form-operatore').innerHTML = "Nuovo Dipendente";
    document.getElementById('titolo-form-operatore').style.color = "#b3d9ff";
    document.getElementById('btn-salva-operatore').innerHTML = "➕ AGGIUNGI OPERATORE";
    document.getElementById('btn-salva-operatore').style.background = "#00cc66";
    document.getElementById('btn-salva-operatore').style.color = "white";
    document.getElementById('btn-annulla-modifica-op').style.display = "none";
};

window.salvaNuovoOperatore = function () {
    let nome = document.getElementById('op-nuovo-nome').value.trim();
    let pin = document.getElementById('op-nuovo-pin').value.trim();
    let ruolo = document.getElementById('op-nuovo-ruolo').value;
    let sconto = parseInt(document.getElementById('op-nuovo-sconto').value) || 0;

    // Controlli base
    if (!nome || pin.length !== 4) {
        mostraAvvisoModale("Devi inserire il Nome dell'operatore e un PIN segreto di 4 cifre.");
        return;
    }

    // Controlla che il PIN non sia già preso DA UN ALTRO dipendente (escludendo me stesso se sto modificando)
    let pinEsistente = listaOperatori.find(o => o.pin === pin && o.id !== idOperatoreInModifica);
    if (pinEsistente) {
        mostraAvvisoModale(`Il PIN inserito è già utilizzato dall'operatore <b>${pinEsistente.nome}</b>.<br>Scegli un PIN univoco.`);
        return;
    }

    if (idOperatoreInModifica) {
        // --- MODALITÀ: MODIFICA ESISTENTE ---
        let opIndex = listaOperatori.findIndex(o => o.id === idOperatoreInModifica);
        if (opIndex > -1) {
            // Sicurezza: Impedisce di declassare l'ultimo Admin a Sales/Manager
            if (listaOperatori[opIndex].ruolo === 'ADMIN' && ruolo !== 'ADMIN') {
                let numAdmin = listaOperatori.filter(o => o.ruolo === 'ADMIN').length;
                if (numAdmin <= 1) {
                    mostraAvvisoModale("Impossibile declassare l'ultimo ADMIN.<br>Deve esserci almeno un Titolare all'interno del gestionale.");
                    return;
                }
            }

            listaOperatori[opIndex].nome = nome;
            listaOperatori[opIndex].pin = pin;
            listaOperatori[opIndex].ruolo = ruolo;
            listaOperatori[opIndex].max_sconto = Math.min(sconto, 100);

            // Se l'Admin sta modificando il suo stesso profilo, aggiorniamo il nome in alto in tempo reale!
            if (operatoreLoggato && operatoreLoggato.id === idOperatoreInModifica) {
                operatoreLoggato = listaOperatori[opIndex];
                document.getElementById('label-operatore').innerHTML = `👤 ${operatoreLoggato.nome} <span style="font-size:1.2vh; color:#888;">(${operatoreLoggato.ruolo})</span>`;
            }

            registraLogSistema("MODIFICA OPERATORE", `Aggiornato account: ${nome} [${ruolo}]`);
            mostraAvvisoModale(`✅ Operatore <b>${nome}</b> aggiornato con successo!`);
        }
    } else {
        // --- MODALITÀ: CREAZIONE NUOVO ---
        let nuovoOp = {
            id: Date.now(),
            nome: nome,
            pin: pin,
            ruolo: ruolo,
            max_sconto: Math.min(sconto, 100)
        };
        listaOperatori.push(nuovoOp);
        registraLogSistema("CREAZIONE OPERATORE", `Creato nuovo account: ${nome} [${ruolo}]`);
        mostraAvvisoModale(`✅ Operatore <b>${nome}</b> aggiunto con successo al sistema!`);
    }

    localStorage.setItem('gestionale_operatori_v2', JSON.stringify(listaOperatori));

    annullaModificaOperatore(); // Pulisce i campi e resetta il layout
    disegnaListaOperatori(); // Ridisegna la tabella aggiornata
};

// Usa la modale universale per confermare l'eliminazione...
window.confermaEliminazioneOperatore = function (idOperatore, nomeOperatore) {
    let op = listaOperatori.find(o => o.id === idOperatore);
    if (!op) return;

    // Sicurezza 1: Non puoi auto-eliminarti
    if (operatoreLoggato && operatoreLoggato.id === idOperatore) {
        mostraAvvisoModale("Non puoi eliminare il tuo stesso account mentre stai lavorando.");
        return;
    }

    // Sicurezza 2: Non puoi eliminare l'ultimo Admin
    if (op.ruolo === 'ADMIN') {
        let numAdmin = listaOperatori.filter(o => o.ruolo === 'ADMIN').length;
        if (numAdmin <= 1) {
            mostraAvvisoModale("Impossibile eliminare.<br>Deve esserci almeno un Titolare (ADMIN) all'interno del gestionale.");
            return;
        }
    }

    // Prepara la variabile universale
    idDaEliminare = idOperatore;
    tipoEliminazione = 'OPERATORE';
    document.getElementById('msg-conferma-elimina').innerHTML = `Sei sicuro di voler revocare l'accesso ed eliminare l'operatore <b>${nomeOperatore}</b>?`;
    apriModale('modal-conferma-elimina');
};

// Agganciamo la logica fisica all'eliminatore universale che già possiedi
let old_eseguiEliminazione_Operatori = window.eseguiEliminazioneUniversale;
window.eseguiEliminazioneUniversale = async function () {
    if (tipoEliminazione === 'OPERATORE') {
        let op = listaOperatori.find(o => o.id === idDaEliminare);
        if (op) {
            // Filtra l'array rimuovendo l'operatore
            listaOperatori = listaOperatori.filter(o => o.id !== idDaEliminare);
            localStorage.setItem('gestionale_operatori_v2', JSON.stringify(listaOperatori));

            disegnaListaOperatori();
            registraLogSistema("ELIMINAZIONE OPERATORE", `Revocato accesso a ${op.nome}`);
            mostraAvvisoModale(`Operatore <b>${op.nome}</b> eliminato dal sistema.`);
        }
        chiudiModale('modal-conferma-elimina');
    } else {
        // Se non è un operatore (è uno scontrino, spesa, magazzino), prosegui normalmente!
        old_eseguiEliminazione_Operatori();
    }
};

// 🔥 MOTORE TRACCIABILITÀ: Scarico FIFO e Controllo PAO
function scaricaLottiFIFO(prodotto, quantitaRichiesta) {
    let qtaDaScaricare = quantitaRichiesta;
    let lottiUtilizzati = [];

    // Se l'articolo non ha la gestione lotti, fa uno scarico classico
    if (!prodotto.lotti || prodotto.lotti.length === 0) {
        prodotto.giacenza -= qtaDaScaricare;
        return [{ lotto: "ND", qta: qtaDaScaricare }];
    }

    // Ordina i lotti dal più vecchio al più nuovo (Data di Carico)
    prodotto.lotti.sort((a, b) => new Date(a.data_carico) - new Date(b.data_carico));

    for (let lotto of prodotto.lotti) {
        if (qtaDaScaricare <= 0) break;

        if (lotto.qta_residua > 0) {
            // CONTROLLO PAO: Segna la data di prima apertura se mai aperto
            if (!lotto.data_apertura) {
                lotto.data_apertura = getOggiString();
            } else if (lotto.pao_mesi) {
                // Verifica se il PAO è scaduto
                let dataApertura = new Date(lotto.data_apertura);
                let oggi = new Date();
                let mesiPassati = (oggi.getFullYear() - dataApertura.getFullYear()) * 12 + (oggi.getMonth() - dataApertura.getMonth());

                if (mesiPassati > lotto.pao_mesi) {
                    // Rispetta la regola di sistema: usare solo avvisi modali
                    mostraAvvisoModale(`⚠️ <b>ALLARME PAO SUPERATO</b><br><br>Il fusto del lotto <b>${lotto.codice_lotto}</b> (Articolo: ${prodotto.descrizione}) risulta aperto da più di ${lotto.pao_mesi} mesi.<br>Verificare immediatamente l'integrità del liquido!`);
                }
            }

            // Prelievo FIFO
            let prelievo = Math.min(lotto.qta_residua, qtaDaScaricare);
            lotto.qta_residua -= prelievo;
            qtaDaScaricare -= prelievo;
            prodotto.giacenza -= prelievo;

            lottiUtilizzati.push({ lotto: lotto.codice_lotto, qta: prelievo });
        }
    }
    return lottiUtilizzati;
}

window.tracciabilitaInversaLotto = async function (codiceLottoDaCercare) {
    let vendite = await getAll('vendite');
    let risultati = [];

    vendite.forEach(v => {
        v.ARTICOLI.forEach(art => {
            if (art.lotti_scaricati) {
                art.lotti_scaricati.forEach(traccia => {
                    let match = traccia.lotti.find(l => l.lotto.toUpperCase() === codiceLottoDaCercare.toUpperCase());
                    if (match) {
                        risultati.push({
                            data_vendita: v.GIORNO,
                            ora: v.ORA,
                            cliente: v.CLIENTE,
                            prodotto_finito: art.DESCRIZIONE,
                            qta_liquido_usato: match.qta
                        });
                    }
                });
            }
        });
    });

    if (risultati.length === 0) {
        mostraAvvisoModale(`Nessuna vendita trovata associata al Lotto: <b>${codiceLottoDaCercare}</b>`);
        return;
    }

    // Costruisce la tabella riepilogativa da mostrare a schermo
    let html = `<div style="text-align: left; max-height: 400px; overflow-y: auto;">
                <p>Risultati per il lotto: <b>${codiceLottoDaCercare}</b></p><hr>`;

    risultati.forEach(r => {
        html += `<p>📅 ${r.data_vendita} ${r.ora} | 👤 <b>${r.cliente}</b><br>
                 📦 Prodotto: ${r.prodotto_finito} (Scarico: ${r.qta_liquido_usato}ml)</p><hr>`;
    });
    html += `</div>`;

    mostraAvvisoModale(html);
};

window.stampaEtichetteNormativeCheckout = function (etichette) {
    let printArea = document.getElementById('print-area');
    printArea.innerHTML = '';
    let canvasIds = [];

    // Recupera i dati aziendali per l'obbligo del Distributore/Produttore
    let nomeNegozio = localStorage.getItem('imp_stampa_nome') || "Profumeria";
    let indirizzoNegozio = localStorage.getItem('imp_stampa_indirizzo') || "Indirizzo non impostato";

    etichette.forEach((et, index) => {
        // Calcolo automatico Prezzo al Litro
        let prezzoLitro = ((et.prezzo / et.formato_ml) * 1000).toLocaleString('it-IT', { minimumFractionDigits: 2 });
        let prezzoDisplay = et.prezzo.toLocaleString('it-IT', { minimumFractionDigits: 2 });

        for (let i = 0; i < et.copie; i++) {
            let idCanvas = `barcode-norm-${index}-${i}`;

            // Impaginazione CSS per stampante termica (es. rotolo adesivo 60x40mm)
            let html = `
            <div class="label-template" style="width: 60mm; height: 40mm; padding: 2mm; box-sizing: border-box; font-family: Arial, sans-serif; color: black; background: white; page-break-after: always; display: flex; flex-direction: column; justify-content: space-between;">
                <div style="font-weight: bold; font-size: 9pt; text-align: center; border-bottom: 1px solid black; padding-bottom: 1mm;">${et.nome_profumo}</div>
                
                <div style="font-size: 7pt; margin-top: 1mm; display: flex; justify-content: space-between;">
                    <span>Formato: <b>${et.formato_ml} ml</b></span>
                    <span>Prezzo: <b>€ ${prezzoDisplay}</b></span>
                </div>
                <div style="font-size: 6pt; text-align: right; color: #333;">(€ ${prezzoLitro}/Lt)</div>
                
                <div style="font-size: 5pt; line-height: 1.1; margin-top: 1mm; height: 8mm; overflow: hidden;">
                    <b>Ingredienti:</b> ${et.inci}
                </div>
                
                <div style="font-size: 6pt; display: flex; justify-content: space-between; margin-top: 1mm; font-weight: bold;">
                    <span>Lotto: ${et.lotto}</span>
                    <span>PAO: ${et.pao}M</span>
                </div>
                
                <div style="text-align: center; margin-top: 1mm;">
                    <canvas id="${idCanvas}" style="max-width: 100%; height: 7mm;"></canvas>
                </div>
                
                <div style="font-size: 5pt; text-align: center; margin-top: 1mm; border-top: 1px dashed #ccc; padding-top: 1mm;">
                    Prodotto/Distribuito da: ${nomeNegozio} - ${indirizzoNegozio}
                </div>
            </div>`;

            let tempDiv = document.createElement('div');
            tempDiv.innerHTML = html;
            printArea.appendChild(tempDiv.firstElementChild);
            canvasIds.push({ id: idCanvas, code: et.barcode });
        }
    });

    // Disegna dinamicamente i codici a barre leggibili in cassa
    canvasIds.forEach(c => {
        JsBarcode("#" + c.id, c.code, {
            format: "CODE128",
            width: 1,
            height: 20,
            displayValue: false,
            margin: 0
        });
    });

    // Lancia la stampa invisibile della termica
    setTimeout(() => window.print(), 500);
};

let formatoSpinaInAttesa = null;

window.apriModaleScegliEssenza = async function (formato) {
    formatoSpinaInAttesa = formato;
    document.getElementById('scegli-essenza-desc').innerHTML = `Stai versando nel formato: <b>${formato.descrizione}</b> <br><span style="color:#b3d9ff; font-size:1.6vh;">(Preleverà automaticamente ${formato.volume_spina} ml)</span>`;
    document.getElementById('cerca-essenza-cassa').value = '';

    let magazzino = await getAll('magazzino');
    // Carica solo le fragranze liquide per non creare confusione
    window.essenzeDisponibili = magazzino.filter(p => p.formato === 'ml' || (p.categoria && p.categoria.toLowerCase().includes('materie')));

    disegnaListaEssenzeCassa(window.essenzeDisponibili);
    apriModale('modal-scegli-essenza');
    setTimeout(() => document.getElementById('cerca-essenza-cassa').focus(), 100);
};

window.filtraEssenzeCassa = function (testo) {
    testo = testo.toLowerCase().trim();
    let filtrati = window.essenzeDisponibili.filter(e => e.descrizione.toLowerCase().includes(testo) || e.codice.toLowerCase().includes(testo));
    disegnaListaEssenzeCassa(filtrati);
};

window.disegnaListaEssenzeCassa = function (essenze) {
    let container = document.getElementById('lista-essenze-cassa');
    container.innerHTML = '';
    essenze.forEach(ess => {
        let div = document.createElement('div');
        div.className = 'voce-lista';
        div.style.padding = '15px 10px';
        div.style.borderBottom = '1px solid #444';
        div.style.cursor = 'pointer'; // Aggiunge la manina al passaggio del mouse
        
        // Ho forzato il colore bianco (#ffffff) e la grandezza (1.8vh) sul nome dell'essenza
        div.innerHTML = `<b style="color: #ffffff; font-size: 1.8vh;">${ess.descrizione}</b> <div style="font-size:1.6vh; color:#00cc66; margin-top: 5px;">Giacenza attuale: ${ess.giacenza} ml</div>`;
        
        div.onclick = () => confermaEssenzaSpina(ess);
        container.appendChild(div);
    });
};

window.confermaEssenzaSpina = function (essenzaScelta) {
    // 1. Creiamo un clone temporaneo del Formato (es. Classic 50ml)
    let prodottoVirtuale = JSON.parse(JSON.stringify(formatoSpinaInAttesa));

    // 2. Uniamo i nomi per lo scontrino e per l'etichetta normativa
    prodottoVirtuale.descrizione = `${essenzaScelta.descrizione} (${formatoSpinaInAttesa.descrizione})`;
    prodottoVirtuale.codice = `${formatoSpinaInAttesa.codice}-${essenzaScelta.codice}`;

    // 3. Calcoliamo il costo del liquido e lo sommiamo al costo del vetro (per mantenere i margini esatti nelle statistiche!)
    let costoLiquido = (essenzaScelta.prezzoAcquisto || 0) * prodottoVirtuale.volume_spina;
    prodottoVirtuale.prezzoAcquisto = (prodottoVirtuale.prezzoAcquisto || 0) + costoLiquido;

    // 4. Assembliamo la Distinta Base al volo aggiungendo il liquido selezionato
    if (!prodottoVirtuale.componenti_kit) prodottoVirtuale.componenti_kit = [];
    prodottoVirtuale.componenti_kit.push({
        codice: essenzaScelta.codice,
        qta: prodottoVirtuale.volume_spina
    });

    prodottoVirtuale.is_kit = true;
    prodottoVirtuale.tipo_kit = 'DINAMICO';
    prodottoVirtuale.is_formato_spina = false; // Spegniamo il flag per evitare loop infiniti

    chiudiModale('modal-scegli-essenza');

    // 5. Lo inviamo alla cassa come se fosse un prodotto normalissimo!
    aggiungiProdotto(prodottoVirtuale);
};

// ==========================================
// ⚖️ LOGICA PAGAMENTO MISTO
// ==========================================
let importoMistoContanti = 0;
let importoMistoPos = 0;
let isRiscattoMistoPendete = false;

window.calcolaRestoMisto = function (fromPos) {
    let modal = document.getElementById('modal-pagamento-misto');
    let daPagare = parseFloat(modal.dataset.daPagare) || 0;

    let inContanti = document.getElementById('misto-contanti');
    let inPos = document.getElementById('misto-pos');

    inContanti.value = inContanti.value.replace(/[^0-9.,]/g, '');
    inPos.value = inPos.value.replace(/[^0-9.,]/g, '');

    if (!fromPos) {
        let valC = parseFloat(inContanti.value.replace(',', '.')) || 0;
        let residuo = daPagare - valC;
        if (residuo < 0) residuo = 0;
        inPos.value = residuo > 0 ? residuo.toFixed(2).replace('.', ',') : '';
    } else {
        let valP = parseFloat(inPos.value.replace(',', '.')) || 0;
        let residuo = daPagare - valP;
        if (residuo < 0) residuo = 0;
        inContanti.value = residuo > 0 ? residuo.toFixed(2).replace('.', ',') : '';
    }
};

window.confermaTransazioneMista = function () {
    let modal = document.getElementById('modal-pagamento-misto');
    let daPagare = parseFloat(modal.dataset.daPagare) || 0;

    let inContanti = document.getElementById('misto-contanti');
    let inPos = document.getElementById('misto-pos');

    let valC = parseFloat(inContanti.value.replace(',', '.')) || 0;
    let valP = parseFloat(inPos.value.replace(',', '.')) || 0;

    let totaleInserito = Math.round((valC + valP) * 100) / 100;
    let daPagareRound = Math.round(daPagare * 100) / 100;

    if (totaleInserito !== daPagareRound) {
        mostraAvvisoModale(`La somma inserita (€ ${totaleInserito.toLocaleString('it-IT', { minimumFractionDigits: 2 })}) non corrisponde al totale da pagare (€ ${daPagareRound.toLocaleString('it-IT', { minimumFractionDigits: 2 })}).`);
        return;
    }

    importoMistoContanti = valC;
    importoMistoPos = valP;

    chiudiModale('modal-pagamento-misto');
    isRiscattoMistoPendete = true;

    let riscattaBonus = modal.dataset.riscattaBonus === 'true';
    confermaVendita(riscattaBonus); // Riprende l'emissione dello scontrino
};

// Esegui la funzione all'avvio dell'app per popolare i menu
window.addEventListener('load', popolaSelectCategorie);

// ==========================================
// ☁️ CLOUD-SYNC: CHIUSURE DI CASSA (Z)
// ==========================================
window.salvaChiusuraCloud = async function (chiusura) {
    if (!FIREBASE_URL || !navigator.onLine) return;
    try { await fetch(`${FIREBASE_URL}/chiusure/${chiusura.data_chiusura}.json`, { method: 'PUT', body: JSON.stringify(chiusura) }); } catch (e) { }
};

window.scaricaChiusureDalCloud = async function () {
    if (!FIREBASE_URL || !navigator.onLine) return;
    try {
        let res = await fetch(`${FIREBASE_URL}/chiusure.json`);
        let data = await res.json();
        if (data) {
            let tx = db.transaction('chiusure', 'readwrite');
            let store = tx.objectStore('chiusure');
            for (let key in data) { store.put(data[key]); }
        }
    } catch (e) { }
};

// ==========================================
// ⏱️ AUTO-SYNC IN BACKGROUND (Ogni 60 secondi)
// ==========================================
setInterval(() => {
    // Scarica i dati in silenzio senza disturbare l'operatore
    if (navigator.onLine) {
        if (typeof scaricaClientiDalCloud === "function") scaricaClientiDalCloud();
        if (typeof scaricaMagazzinoDalCloud === "function") scaricaMagazzinoDalCloud();
        if (typeof scaricaVenditeDalCloud === "function") scaricaVenditeDalCloud();
        if (typeof scaricaMovimentiDalCloud === "function") scaricaMovimentiDalCloud();

        // --- NUOVI DOWNLOAD CLOUD ---
        if (typeof scaricaVouchersDalCloud === "function") scaricaVouchersDalCloud();
        if (typeof scaricaOrdiniDalCloud === "function") scaricaOrdiniDalCloud();
        if (typeof scaricaChiusureDalCloud === "function") scaricaChiusureDalCloud();
        // --- GIFTCARD DOWNLOAD CLOUD ---
        if (typeof scaricaGiftCardsDalCloud === "function") scaricaGiftCardsDalCloud();
    }
}, 60000);

// ==========================================
// ☁️ CLOUD-SYNC: GIFT CARDS
// ==========================================
window.salvaGiftCardCloud = async function (gc) {
    if (!FIREBASE_URL || !navigator.onLine) return;
    try { await fetch(`${FIREBASE_URL}/giftcards/${gc.codice}.json`, { method: 'PUT', body: JSON.stringify(gc) }); } catch (e) { }
};

window.scaricaGiftCardsDalCloud = async function () {
    if (!FIREBASE_URL) return;
    try {
        let res = await fetch(`${FIREBASE_URL}/giftcards.json`);
        if (!res.ok) return;
        let data = await res.json();
        if (data && !data.error) {
            let tx = db.transaction('giftcards', 'readwrite');
            let store = tx.objectStore('giftcards');
            for (let key in data) { store.put(data[key]); }
        }
    } catch (e) { }
};

// ========================================================
// NAVIGAZIONE CON FRECCE E INVIO - ANALISI CLIENTI
// ========================================================
let indiceSelezioneAnalisi = -1;

document.addEventListener('DOMContentLoaded', () => {
    const inputRicerca = document.getElementById('stat-cerca-cliente');
    const contenitoreRisultati = document.getElementById('stat-lista-clienti-ricerca');

    if (inputRicerca && contenitoreRisultati) {

        // Resetta l'indice ogni volta che l'utente digita una nuova lettera
        inputRicerca.addEventListener('input', () => {
            indiceSelezioneAnalisi = -1;
        });

        // Ascolta la pressione dei tasti
        inputRicerca.addEventListener('keydown', function (e) {
            // Prende tutti i div dei clienti generati nel contenitore
            let items = contenitoreRisultati.querySelectorAll('div');
            if (items.length === 0) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault(); // Evita che il cursore scatti all'inizio/fine del testo
                indiceSelezioneAnalisi++;
                if (indiceSelezioneAnalisi >= items.length) indiceSelezioneAnalisi = 0; // Torna all'inizio
                aggiornaEvidenziazioneAnalisi(items);
            }
            else if (e.key === 'ArrowUp') {
                e.preventDefault();
                indiceSelezioneAnalisi--;
                if (indiceSelezioneAnalisi < 0) indiceSelezioneAnalisi = items.length - 1; // Va alla fine
                aggiornaEvidenziazioneAnalisi(items);
            }
            else if (e.key === 'Enter') {
                e.preventDefault();
                if (indiceSelezioneAnalisi >= 0 && items[indiceSelezioneAnalisi]) {
                    // Simula il click del mouse sul cliente selezionato
                    items[indiceSelezioneAnalisi].click();
                    indiceSelezioneAnalisi = -1; // Resetta dopo la selezione
                }
            }
        });

        // Funzione per colorare l'elemento selezionato
        function aggiornaEvidenziazioneAnalisi(items) {
            // Rimuove l'evidenziazione da tutti
            items.forEach(item => {
                item.style.backgroundColor = '';
                item.style.color = '';
                item.style.borderLeft = '';
            });

            // Applica l'evidenziazione a quello attivo
            if (items[indiceSelezioneAnalisi]) {
                let elementoAttivo = items[indiceSelezioneAnalisi];

                // Stile di selezione visiva (azzurro in tema col gestionale)
                elementoAttivo.style.backgroundColor = 'rgba(77, 136, 255, 0.3)';
                elementoAttivo.style.color = '#ffffff';
                elementoAttivo.style.borderLeft = '4px solid #4d88ff';

                // Fa scorrere automaticamente la lista se l'elemento è fuori vista
                elementoAttivo.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }
    }
});

// ==========================================
// 🛡️ FILTRO GLOBALE CAMPI NUMERICI E IMPORTI
// ==========================================
document.querySelectorAll('input[inputmode="decimal"], input[inputmode="numeric"]').forEach(input => {
    input.addEventListener('input', function () {
        // Elimina in tempo reale qualsiasi lettera o simbolo non consentito.
        // Lascia passare solo: numeri (0-9), virgola (,), punto (.), simbolo euro (€), spazio e segno meno (-)
        this.value = this.value.replace(/[^0-9.,€ \-]/g, '');
    });
});

// Modifica il tasto "ESCI" della cassa (prima icona in alto a sx)
// affinché invece di chiudere l'app, torni al Menu Principale
const btnEsciCassa = document.querySelector('.tasto-fisico img[src*="esci.png"]').parentElement;
btnEsciCassa.onclick = function () {
    apriModale('modal-menu-principale');
};

// Ascoltatori di eventi integrati nel browser per la rete
window.addEventListener('online', aggiornaStatoRete);
window.addEventListener('offline', aggiornaStatoRete);

// Controllo iniziale all'avvio
aggiornaStatoRete();
