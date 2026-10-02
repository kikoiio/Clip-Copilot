import { fileURLToPath } from "node:url";
import { commands } from "./workflow/coordinator.ts";

type CommandHandler = (args: string[]) => Promise<number>;

const HELP = `山间清晨短片工作流

用法: npm run cli -- <命令> [参数]

命令:
  init        --workspace <目录> --config <任务配置JSON>
                                        依据任务配置创建新工作区（新工作区必须来自任务配置）
  ingest      --workspace <目录> --file <视频>         登记一段素材（来源与许可参数见下）
                --source-url <URL> --license-url <URL>
                [--reason <文本>]                     登记任务配置候选清单外的素材时必须说明替换原因
  score       --workspace <目录> [--plan <JSON>]      保存配乐方案；缺省时打印当前方案
  edit        --workspace <目录> [--plan <JSON>]      保存剪辑方案；缺省时打印当前方案
  render      --workspace <目录> score|video|final    生成工程并导出当前阶段产物
  verify      --workspace <目录>                      运行可自动化的全部检查（含深度检查与
                                                        无界面工程验证；硬伤退出码非 0）
  checkpoint  --workspace <目录> --summary <文本>      提交当前阶段检查点（不可变副本；
                                                        产物带未豁免硬伤时拒绝提交）
  review      --workspace <目录> --decision approve|changes [--feedback <文本>]
                                                      记录创作者对当前检查点的意见
  waive       --workspace <目录> --check <检查项ID> [--artifact <产物ID>] --reason <文本>
                                                      豁免一条机器检查结论（原因必填、进决定
                                                      记录；豁免后该项在门禁中降级为告警）
  reopen      --workspace <目录> [--reason <文本>]    重开已交付（done）工作区的视频版本
                                                      （产物失效并回到 video_draft，用于适配器
                                                      升级后重新生成工程等场景）
  resume      --workspace <目录>                      依据状态与指纹恢复，重建 handoff.md
  status      --workspace <目录>                      打印阶段、产物与下一步

环境变量:
  LMMS_APPIMAGE      LMMS AppImage 路径（默认 /home/neo/Applications/lmms-1.2.2-linux-x86_64.AppImage）
  KDENLIVE_APPIMAGE  Kdenlive AppImage 路径（默认 /home/neo/Applications/kdenlive-26.08.1-x86_64.AppImage）

说明: 到达配乐或粗剪检查点后，工作流会等待 review 命令的明确意见后继续。
`;

function getFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`参数 ${flag} 缺少取值`);
  }
  return value;
}

function requireWorkspace(args: string[]): string {
  const workspace = getFlag(args, "--workspace");
  if (!workspace) throw new Error("缺少 --workspace 参数");
  return workspace;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  const handler: CommandHandler | undefined = commands[command];
  if (!handler) {
    process.stderr.write(`未知命令: ${command}\n\n${HELP}`);
    return 2;
  }
  try {
    return await handler(rest);
  } catch (err) {
    process.stderr.write(`[错误] ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

const invoked = process.argv[1] === undefined
  ? false
  : process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1].endsWith("cli.js");
if (invoked) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`[错误] ${String(err)}\n`);
      process.exit(1);
    },
  );
}
