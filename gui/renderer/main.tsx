import { createRoot } from "react-dom/client";

function App() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>AI 创作工作台</h1>
      <p>GUI 壳已就绪（T1 占位；工作区看板等视图由后续任务填充）。</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
