(() => {
  const chat = document.getElementById("chat");
  const script = JSON.parse(chat.dataset.script);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const add = (m) => {
    const d = document.createElement("div");
    const me = "me" in m;
    d.className = "msg " + (me ? "me" : "bot");
    // script content is authored in index.html, not user input
    d.innerHTML = me ? m.me : m.bot;
    chat.appendChild(d);
    while (chat.children.length > 6) chat.firstChild.remove();
  };

  const play = async () => {
    for (;;) {
      chat.textContent = "";
      for (const m of script) {
        add(m);
        await new Promise((r) => setTimeout(r, "me" in m ? 700 : 1700));
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  };

  if (reduce) script.forEach(add);
  else play();

  document.querySelectorAll(".card").forEach((c) =>
    c.addEventListener("pointermove", (e) => {
      const r = c.getBoundingClientRect();
      c.style.setProperty("--x", e.clientX - r.left + "px");
      c.style.setProperty("--y", e.clientY - r.top + "px");
    }),
  );
  document.getElementById("yr").textContent = new Date().getFullYear();
})();
