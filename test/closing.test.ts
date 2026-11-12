// The closing-message rules, case by case: does a turn's last message ask you something,
// and when it does, is the question this session's own or another session's that it passes on?
// Run with `bun test`. Every text here is made up.
import { expect, test } from "bun:test";
import { classifyClosing, type Other } from "../closing.ts";

const DRAFT = "local_5d1e7a20-3b4c-4d5e-8f60-718293a4b5c6";
const BILLING = "local_1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";
const others: Other[] = [
  { sid: "cli-draft", local: DRAFT, names: ["Draft review 58"] },
  { sid: "cli-billing", local: BILLING, names: ["billing-api: retry rules", "/tmp/demo"] },
  { sid: "cli-notes", local: "local_9f8e7d6c-1111-4222-8333-444455556666", names: ["Meeting notes"] },
];
// The same sessions as the server knows them when it has no app file for billing: only a
// title and a folder.
const byName: Other[] = [{ sid: "cli-billing", names: ["Retry rules", "billing-api"] }];
const link = `[Draft review 58](#${DRAFT})`;

type Row = {
  text: string;
  // asks: a question or request for you, this session's own. done: nothing for you here.
  // relayed: a question this session passes on from another one, which you answer there.
  is: "asks" | "done" | "relayed";
  ask?: string | RegExp; // what the card says (askText)
  relayed?: string[];
  others?: Other[];
  own?: string[]; // this session's own names
};

const rows: [string, Row][] = [
  // Ordinary "done" closings that look like asks.
  ["Spanish third person: elige", { text: "Listo, quedó el cambio. El servidor elige el puerto libre al arrancar.", is: "done" }],
  ["Spanish third person: decide", { text: "Listo, quedó el cambio. El servidor decide el puerto libre al arrancar.", is: "done" }],
  ["Spanish third person: aprueba", { text: "Listo, quedó el cambio. El servidor aprueba el puerto libre al arrancar.", is: "done" }],
  ["Spanish third person: escoge", { text: "Listo, quedó el cambio. El servidor escoge el puerto libre al arrancar.", is: "done" }],
  ["Spanish third person: confirma", { text: "Corrí las pruebas. El reporte confirma que el caché ya no se queda viejo.", is: "done" }],
  ["the logs tell me", { text: "Done. The logs tell me the cache was stale, so I cleared it.", is: "done" }],
  ["a rhetorical why, then its answer", { text: "Encontré el bug. ¿Por qué fallaba? La regla estaba en otra hoja.", is: "done" }],
  ["a rhetorical what, then its answer", { text: "Ya quedó. ¿Qué cambió? Solo el orden de las columnas.", is: "done" }],
  ["a rhetorical why in English", { text: "Fixed. Why did it fail? The cache key changed between builds.", is: "done" }],
  ["a question answered with a yes", { text: "Lo revisé otra vez. ¿Funcionó? Sí, ya pasa la prueba.", is: "done" }],
  ["que prefieres in a report", { text: "Quedó con el tono que prefieres.", is: "done" }],
  ["quieres que as a relative clause", { text: "Lo dejé como quieres que quede, con el título arriba.", is: "done" }],
  ["I couldn't approve", { text: "I couldn't approve the PR myself, so it stays open for review.", is: "done" }],
  ["someone else will approve", { text: "The reviewer will approve it after lunch. Nothing else is pending.", is: "done" }],
  ["the user picks", { text: "Done. The user picks a slot and the invite goes out on its own.", is: "done" }],
  ["the tool decides which", { text: "Done. The tool decides which file to keep, so there's nothing to choose.", is: "done" }],
  ["lo hago yo as a plan", { text: "Lo hago yo mañana temprano, ya quedó anotado.", is: "done" }],
  ["picked which one", { text: "I kept which one compiles fastest and removed the other.", is: "done" }],
  ["a script confirms and decides", { text: "Listo. El script confirma que el puerto está libre y decide solo cuál usar.", is: "done" }],
  ["a bot picks, tomorrow", { text: "Mañana el bot elige un ganador al azar.", is: "done" }],
  ["a team decides", { text: "Note: the team decides on Friday which one ships.", is: "done" }],
  ["answered in its session already", { text: "Ya respondí las dos preguntas en su sesión.", is: "done" }],

  // Closings that ask you, and more like them.
  ["a yes/no question, then why", { text: "Quedó listo el cambio. ¿Lo subo a main? Así sale hoy y mañana ya lo ven todos.", is: "asks", ask: "¿Lo subo a main?" }],
  ["a question offering two options", { text: "Quedó el borrador. ¿Lo mando así o le cambio el tono?", is: "asks" }],
  ["dime cuál", { text: "Hay dos versiones. Dime cuál de las dos subo.", is: "asks" }],
  ["should I merge", { text: "The fix is ready on the branch. Should I merge it into main?", is: "asks" }],
  ["necesito que apruebes", { text: "Necesito que apruebes el cambio antes de publicarlo.", is: "asks" }],
  ["approve, as an imperative", { text: "The branch is ready. Approve the PR when you can and I'll merge it.", is: "asks" }],
  ["elige, as an imperative", { text: "Quedaron dos portadas. Elige una y la dejo lista.", is: "asks" }],
  ["escoge after a condition", { text: "Quedaron dos tonos. Si te late, escoge el azul y lo aplico.", is: "asks" }],
  ["tú decide", { text: "Quedó en borrador. Tú decide si lo publico hoy.", is: "asks" }],
  ["apruébalo", { text: "El PR quedó abierto. Apruébalo cuando puedas.", is: "asks" }],
  ["tell me which", { text: "Both builds pass. Tell me which one to keep.", is: "asks" }],
  ["cuál prefieres, without a question mark", { text: "Hay dos tonos, formal y cercano. Solo dime cuál prefieres.", is: "asks" }],
  ["cuál prefieres, as a question with options after it", { text: "Quedaron dos tonos. ¿Cuál prefieres? El formal suena más serio.", is: "asks" }],
  ["your go-ahead", { text: "The draft is done. I need your go-ahead before I publish it.", is: "asks" }],
  ["pick one", { text: "There are two layouts. Pick one and I'll finish it.", is: "asks" }],
  ["te toca", { text: "Ya quedó la parte del servidor. Te toca responder las dos preguntas del formulario.", is: "asks" }],
  ["quieres que, without a question mark", { text: "Quedó el borrador. Quieres que lo suba hoy", is: "asks" }],
  ["a how question with a verb in the first person", { text: "¿Cómo lo dejo, con o sin título? Así como está se ve bien.", is: "asks", ask: "¿Cómo lo dejo, con o sin título?" }],
  ["a why-not proposal", { text: "No sé si conviene. ¿Por qué no lo probamos mañana? Así vemos la carga real.", is: "asks" }],
  ["what should, then the current value", { text: "What should the default be? Right now it's 30 seconds.", is: "asks" }],
  ["confirma, as an imperative", { text: "Ya está. Confirma el PR cuando puedas.", is: "asks" }],
  ["you need to approve", { text: "The release is staged. You need to approve the deploy before it goes out.", is: "asks" }],

  // The end-to-end scenarios, ported.
  ["11 a closing question", { text: "Here is the draft.\n\nIt has 180 words. ¿Lo publico en el blog? Cuando me confirmes, lo subo.", is: "asks", ask: "¿Lo publico en el blog?" }],
  ["12 a question mid-text is not the ending", { text: "Fixed it? Yes. The test passes now and the build is green.", is: "done" }],
  ["15 a request with no question mark", { text: "Quedó el borrador.\n\nSolo me falta saber si lo publicas tú o si lo publico yo. Con un \"publícalo\" lo subo.", is: "asks", ask: /me falta saber/ }],
  ["16 a courtesy closing", { text: "Publiqué el reporte y el enlace ya funciona. Si necesitas algo más, avísame.", is: "done" }],
  ["18 an old question", { text: "Escribí el borrador con los tres ejemplos. ¿Lo publico hoy?", is: "asks" }],
  ["23 an open offer for more", { text: "Ya está publicada la versión nueva. Si quieres seguir con otro ajuste, dime.", is: "done" }],
  ["24 a short anything else", { text: "El banner ya está arriba. ¿Algo más?", is: "done" }],
  ["25 an offer of one thing", { text: "Dejé el borrador listo. Si quieres que lo suba, dime.", is: "asks", ask: /lo suba/ }],
  ["26 an open offer in English", { text: "Done. Let me know if you want me to make any other changes.", is: "done" }],
  ["27 an offer of one thing in English", { text: "The draft is ready. Let me know if you want me to push it.", is: "asks", ask: /push it/ }],
  ["39 a plain done", { text: "Listo, quedó arreglado.", is: "done" }],
  ["42 dime cuál", { text: "Revisé el buzón. Dime cuál carpeta limpio primero.", is: "asks" }],
  ["52 all set", { text: "All set, the notes are tidy.", is: "done" }],
  ["53 a quoted question", { text: "Yes, it went out at 3:54 PM. I checked it in the chat after sending it:\n\n> @Sam, what can you share from the tool? Screens or an example would work.", is: "done" }],
  ["57 a question relayed from a linked session", { text: `The ${link} session can't start until you answer: who is the image for?`, is: "relayed", relayed: ["cli-draft"] }],
  ["66 its own question beside a link", { text: `I started ${link} for the icons. Should I also push the branch?`, is: "asks", ask: "Should I also push the branch?" }],
  ["68 questions under a lead-in that relays them", { text: `La sesión ${link} te hace dos preguntas; contéstalas en esa sesión:\n\n1. ¿Quién la va a ver?\n2. ¿Qué tamaños?`, is: "relayed", relayed: ["cli-draft"] }],
  ["70 its own question after a relayed one", { text: `Aparte, ${link} te espera en esa sesión.\n\n¿Subo los cambios?`, is: "asks", ask: "¿Subo los cambios?" }],
  ["72 a question in a point of the closing list", { text: "Quedó terminada la primera parte.\n\n**Lo que queda:**\n1. **La segunda parte, el menú.** Es grande: de 6 a 10 rondas. ¿La arranco?\n2. **Los textos de la portada** siguen siendo propuesta mía.\n3. **Los zips son de la versión 2.0.** Si vas a mandar algo, los saco con un comando.", is: "asks", ask: "La segunda parte, el menú. ¿La arranco?" }],
  ["73 a point that needs your approval", { text: "Here's where it stands:\n\n- The build passes.\n\n- The icons need your approval before I export them.\n\n- The zips are still on 2.0. Nothing else changed. No new commits.", is: "asks", ask: /need your approval/ }],
  ["74 a point that waits for your OK", { text: "Listo el cambio.\n\nPendientes:\n- Los textos nuevos esperan tu visto bueno.\n- La versión es la 2.1. El zip sigue igual. No hay commits nuevos.", is: "asks", ask: /visto bueno/ }],
  ["75 a point that only adds an option", { text: "**A tener en cuenta:**\n- **Colores:** en la portada el azul es más oscuro que en el menú. Si prefieres que coincidan, los igualo.\n- **Otras versiones:** siguen en la liga de antes.\n- **Sin commit:** no exporté nada. Estos cambios no están en commit.", is: "done" }],
  ["76 a question a point answers itself", { text: "**Qué cambió:**\n1. **¿Por qué fallaba?** La regla estaba en otra hoja de estilos.\n2. **Pruebas:** 17 de 17, en desarrollo y en build.", is: "done" }],
  ["77 a command still running", { text: "The comparison is still running. I'll tell you what it finds when it ends.", is: "done" }],
  ["81 waiting for you to choose", { text: "Quedó anotado el rechazo. La respuesta al cliente sigue esperando que elijas versión: tal cual, o con la línea nueva.", is: "asks", ask: /elijas/ }],
  ["82 waiting for you to pick", { text: "The notes are filed. The invite is still waiting for you to pick a slot.", is: "asks" }],
  ["83 nothing waits on you", { text: "Revisé las tres sesiones. Nada espera tu respuesta.", is: "done" }],
  ["84 only if something waits", { text: "Sigo vigilando. Solo te escribo si algo espera tu respuesta y no lo has visto.", is: "done" }],

  // Another session's questions, named by its id or its short name: you answer them there.
  ["relay: short id, Spanish", { text: "Terminé el cambio del cliente. Falta que respondas las dos preguntas de billing-api en su sesión (local_1a2b3c4d).", is: "relayed", relayed: ["cli-billing"] }],
  ["relay: short id, after what's left on your side", { text: "Quedó el cambio. Lo que queda de tu lado: responder las dos preguntas de billing-api en su sesión (local_1a2b3c4d).", is: "relayed", relayed: ["cli-billing"] }],
  ["relay: full id in parentheses", { text: `Terminé. Te toca responder las dos preguntas de billing-api en su sesión (${BILLING}).`, is: "relayed", relayed: ["cli-billing"] }],
  ["relay: short name only, Spanish", { text: "Terminé el cambio. Falta que respondas las dos preguntas de billing-api en su sesión.", is: "relayed", relayed: ["cli-billing"], others: byName }],
  ["relay: short name, question form", { text: "Listo el cambio. ¿Puedes responder las dos preguntas de billing-api en su sesión?", is: "relayed", relayed: ["cli-billing"], others: byName }],
  ["relay: short id, English", { text: "The client change is done. Next, answer billing-api's two questions in its session (local_1a2b3c4d).", is: "relayed", relayed: ["cli-billing"] }],
  ["relay: short name, English", { text: "The client change is done. You still need to answer billing-api's two questions in its own session.", is: "relayed", relayed: ["cli-billing"], others: byName }],
  ["relay: short name, English, waiting", { text: "Done here. billing-api is waiting for you to answer two questions in its session.", is: "relayed", relayed: ["cli-billing"], others: byName }],
  ["not a relay: this session's own name", { text: "Terminé el cambio. ¿Subo billing-api a main?", is: "asks", others: byName, own: ["billing-api"] }],
  ["not a relay: a name with no word of waiting", { text: "Ya quedó la parte de billing-api. ¿Subo los cambios?", is: "asks", others: byName }],
];

for (const [name, row] of rows) {
  test(name, () => {
    const r = classifyClosing(row.text, row.others ?? others, row.own ?? []);
    const got = !r.ask ? "done" : r.relayed.length ? "relayed" : "asks";
    expect({ is: got, ask: r.askText }).toMatchObject({ is: row.is });
    if (typeof row.ask === "string") expect(r.askText).toBe(row.ask);
    else if (row.ask) expect(r.askText ?? "").toMatch(row.ask);
    if (row.relayed) expect(r.relayed).toEqual(row.relayed);
  });
}

test("a relayed session is listed among the ones that wait for you", () => {
  const r = classifyClosing(`Aparte, ${link} te espera en esa sesión.\n\n¿Subo los cambios?`, others, []);
  expect(r.relays).toEqual(["cli-draft"]);
  expect(classifyClosing("Falta que respondas las preguntas de billing-api en su sesión (local_1a2b3c4d).", others, []).relays).toEqual(["cli-billing"]);
});

test("a linked session that waits for you to pick is listed, and this one asks nothing", () => {
  const r = classifyClosing(`La sesión del borrador espera que escojas una de las dos portadas: ${link}.\n\nAparte, las pruebas pasan.`, others, []);
  expect(r.ask).toBeUndefined();
  expect(r.relays).toEqual(["cli-draft"]);
});

const asks = rows.filter(([, r]) => r.is === "asks").length;
test(`the table holds both kinds (${asks} asks, ${rows.length - asks} not)`, () => {
  expect(asks).toBeGreaterThan(20);
  expect(rows.length - asks).toBeGreaterThan(20);
});
