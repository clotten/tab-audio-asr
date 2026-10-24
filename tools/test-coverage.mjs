import { looksTruncated, informationUnits, splitInHalf, betterOf, endsMidSentence, shouldRetrySplit } from "../lib/coverage.js";

let failed = 0;
const check = (n, c, e = "") => { if (c) console.log(`  PASS  ${n}`); else { failed++; console.log(`  FAIL  ${n}${e ? "  → " + e : ""}`); } };

console.log("\n1) 信息量统计");
{
  check("中文按字计", informationUnits("今天天气不错") === 6, String(informationUnits("今天天气不错")));
  check("英文按词计", informationUnits("hello world foo") === 3, String(informationUnits("hello world foo")));
  check("日文假名计入", informationUnits("ありがとう") === 5, String(informationUnits("ありがとう")));
  check("忽略标点", informationUnits("你好，世界！") === 4, String(informationUnits("你好，世界！")));
  check("空串为 0", informationUnits("") === 0);
}

console.log("\n2) 截断判定");
{
  check("20 秒只有 6 字 → 可疑", looksTruncated("今天天气不错", 20000) === true);
  check("20 秒 60 字 → 正常", looksTruncated("今天天气不错我们一起去公园散步然后吃个饭再看场电影怎么样我觉得挺好的就这样定了好不好", 20000) === false);
  check("5 秒太短不判断", looksTruncated("你好", 5000) === false);
  check("12 秒 30 字 → 正常", looksTruncated("今天天气不错我们一起去公园散步然后吃个饭再看场电影怎么样", 12000) === false);
  check("12 秒 10 字 → 可疑", looksTruncated("今天天气不错我们去公园", 12000) === true);
}

console.log("\n3) 切半");
{
  const halves = splitInHalf(0, 1000);
  check("切成两段", halves && halves.length === 2);
  check("中点正确", halves[0].endSample === 500 && halves[1].startSample === 500);
  check("退化区间返回 null", splitInHalf(100, 101) === null);
}

console.log("\n3.5) 句尾悬空（更灵敏的截断信号）");
{
  check("没有句末标点 → 悬空", endsMidSentence("I think because of how much I was trying to help") === true);
  check("以 and 结尾 → 悬空", endsMidSentence("the number of times i slip your keys and") === true);
  check("完整句子 → 不悬空", endsMidSentence("Just go to sleep.") === false);
  check("中文句号收尾 → 不悬空", endsMidSentence("快睡吧。") === false);
  check("残句所谓句号（...I.）→ 悬空", endsMidSentence("I think, because of how much I was trying to help, I.") === true);
  check("问号收尾 → 不悬空", endsMidSentence("Are you kidding me?") === false);
}

console.log("\n3.6) 综合判定");
{
  check("密度低 → low-density", shouldRetrySplit("今天天气不错", 20000) === "low-density");
  check("密度正常但句子没说完 → dangling-tail", shouldRetrySplit("this is a long english sentence that goes on and on about something", 8000) === "dangling-tail");
  check("完整句子 → 不重试", shouldRetrySplit("Just go to sleep now because you really need rest tonight my friend.", 12000) === "");
  check("太短不判悬空", shouldRetrySplit("hi and", 3000) === "");
}

console.log("\n4) 择优");
{
  const a = betterOf("今天天气", ["今天天气不错我们", "一起去公园散步"]);
  check("半边更全时选 halves", a.use === "halves", a.use);
  const b = betterOf("今天天气不错我们一起去公园散步然后吃个饭", ["今天天气", "不错"]);
  check("整段更全时保留 original", b.use === "original", b.use);
}

console.log("");
if (failed) { console.log(`${failed} 项失败`); process.exit(1); }
console.log("全部通过");
