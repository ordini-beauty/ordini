# Ordini Beauty

Web app installabile (iPhone e Mac) per gestire clienti, consegne, incassi e guadagni.

## Messa in funzione
1. Console Firebase → crea un progetto (piano gratuito Spark) oppure usa quello di Make it easy.
2. Authentication → Metodo di accesso → abilita **Email/password**.
3. Firestore Database → crea il database (modalità produzione, regione europe-west).
4. Firestore → Regole → incolla il contenuto di `firestore.rules` e pubblica.
5. Impostazioni progetto → Aggiungi app Web → copia la config in `firebase-config.js`.
6. Authentication → Impostazioni → Domini autorizzati → aggiungi il dominio GitHub Pages.
7. Carica la cartella in un repository GitHub e attiva GitHub Pages.
8. Su iPhone: apri il link in Safari → Condividi → Aggiungi alla schermata Home.
   Su Mac: Safari → File → Aggiungi al Dock.

## Come calcola il guadagno
- Costo ordine = quanto pagato a Yves Rocher.
- Quota "Io" = costo dei suoi acquisti personali (proporzionale al valore, oppure inserita a mano).
- Guadagno = venduto ai clienti − (costo ordine − quota Io).

## Funzioni
- **Da fare**: consegne e incassi per cliente, messaggio WhatsApp già pronto, clienti da ricontattare.
- **Ordini**: righe per cliente, aggiunta rapida prodotti con prezzo ricordato, omaggi ricevuti e dati, promemoria di riacquisto.
- **Clienti**: storico, quanto deve, WhatsApp.
- **Omaggi**: giacenza (ricevuti − dati ± movimenti manuali).
- **Riepilogo**: guadagni mese/anno, soglia di ricontatto, import del vecchio Excel, export CSV, backup e ripristino.

## Import del vecchio Excel
Riepilogo → "Importa il vecchio file Excel". Colonne lette: Data, Cliente, Dettaglio, Omaggio, Fatturato, Entrate, Uscite.
- Ordini con un solo cliente → assegnati a quel cliente.
- Ordini con più clienti → restano "di gruppo" (il file non dice quanto ha speso ciascuna).
- "io" nella colonna Cliente → acquisto personale = Fatturato − Entrate.
- Tutto importato come pagato e consegnato. Importare una sola volta: un secondo import duplica.

## Backup
Il backup è un file .json scaricato sul dispositivo; l'app ricorda di farlo ogni 30 giorni.
Non può partire da solo senza un server a pagamento.
