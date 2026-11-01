const dice = [document.querySelector("#die-one"), document.querySelector("#die-two")];
const rollButton = document.querySelector("#roll-button");
const totalDisplay = document.querySelector("#result-total");
const messageDisplay = document.querySelector("#result-message");
const roundsDisplay = document.querySelector("#round-count");
const winsDisplay = document.querySelector("#win-count");
const rateDisplay = document.querySelector("#win-rate");

let rounds = 0;
let wins = 0;

function setDie(die, value) {
  die.dataset.value = value;
  die.setAttribute("aria-label", `骰子：${value} 点`);
}

function rollDice() {
  if (rollButton.disabled) return;

  rollButton.disabled = true;
  dice.forEach((die) => die.classList.add("is-rolling"));

  window.setTimeout(() => {
    const [first, second] = dice.map(() => Math.floor(Math.random() * 6) + 1);
    const total = first + second;
    const isWin = total === 7;

    setDie(dice[0], first);
    setDie(dice[1], second);
    totalDisplay.textContent = String(total);
    messageDisplay.textContent = isWin ? "恭喜你！正好掷出了幸运 7！" : `差一点点，再来一次吧！`;
    messageDisplay.classList.toggle("is-win", isWin);
    messageDisplay.classList.toggle("is-loss", !isWin);

    rounds += 1;
    if (isWin) wins += 1;
    roundsDisplay.textContent = String(rounds);
    winsDisplay.textContent = String(wins);
    rateDisplay.textContent = `${Math.round((wins / rounds) * 100)}%`;

    dice.forEach((die) => die.classList.remove("is-rolling"));
    rollButton.disabled = false;
    rollButton.focus();
  }, 560);
}

rollButton.addEventListener("click", rollDice);
