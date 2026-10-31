// 「フルネームを教えてください」 (#/fullname, 2026-11-01): somebody who already has an account is asked once for
// the full name and the company / 所属, so people can tell who is who at a 会. Before the date the server
// gives (config.fullname) it is a request: 「あとで」 closes it and it comes back the next time the app is
// opened. From that date it cannot be closed. The rules are in fullname-rules.js.

import { api } from '../net.js';
import { config } from '../config.js';
import { state } from '../state.js';
import { onboardingStep } from '../onboarding.js';
import { navigate, screen } from '../router.js';
import { $ } from '../ui.js';
import { FULLNAME_WORDS, nameMax, needsFullname, validateFullname } from '../fullname-rules.js';

// A request is shown once per opening of the app: set when the app starts (boot), cleared by saving or 「あとで」.
let due = false;
let returnTo = null;

/** boot(): this opening of the app has a request to show (only for somebody who is through signing up). */
export function markFullnameDue() {
  due = needsFullname(config(), state.account) !== 'no' && !onboardingStep();
}

/** The guard's question: must this person be held on #/fullname now? */
export function fullnameHeld() {
  if (onboardingStep()) return false;
  const mode = needsFullname(config(), state.account);
  if (mode === 'required') return true;
  return mode === 'ask' && due;
}

export const rememberFullnameReturn = (hash) => { returnTo = hash; };

export function setupFullname() {
  const name = $('fullnameName');
  const affiliation = $('fullnameAffiliation');
  const save = $('fullnameSave');
  let mode = 'ask';

  const sync = () => { save.disabled = !name.value.trim() || !affiliation.value.trim(); };
  name.addEventListener('input', sync);
  affiliation.addEventListener('input', sync);

  const leave = () => {
    const target = returnTo && returnTo !== '#/fullname' ? returnTo : '#/map';
    returnTo = null;
    return navigate(target, { replace: true });
  };

  save.addEventListener('click', async () => {
    const check = validateFullname({ name: name.value, affiliation: affiliation.value }, config());
    if (!check.ok) {
      $('fullnameError').textContent = check.message;
      return;
    }
    save.disabled = true;
    $('fullnameError').textContent = '';
    try {
      const result = await api.put('/api/account/me', {
        display_name: check.name, affiliation: check.affiliation, name_confirmed: true,
      });
      state.account = result.account;
      due = false;
      await leave();
    } catch (error) {
      $('fullnameError').textContent = error.message;
      sync();
    }
  });

  $('fullnameLater').addEventListener('click', () => {
    if (mode !== 'ask') return;
    due = false;
    leave();
  });

  screen('fullname', {
    enter() {
      mode = needsFullname(config(), state.account);
      if (mode === 'no') { navigate('#/map', { replace: true }); return; }
      const rule = config().fullname || {};
      const required = mode === 'required';
      $('fullnameBadge').textContent = required ? FULLNAME_WORDS.requiredBadge(rule.from) : FULLNAME_WORDS.askBadge(rule.from);
      $('fullnameLede').textContent = FULLNAME_WORDS.lede;
      $('fullnameNote').textContent = required ? FULLNAME_WORDS.noteRequired : FULLNAME_WORDS.noteAsk;
      $('fullnameLater').hidden = required;
      $('fullnameStuck').hidden = !required;
      $('fullnameStuck').textContent = FULLNAME_WORDS.stuck;
      name.maxLength = nameMax(config());
      // The nickname is the draft: the person only has to correct it.
      name.value = state.account.display_name || '';
      affiliation.value = state.account.affiliation || '';
      affiliation.placeholder = FULLNAME_WORDS.affiliationPlaceholder;
      $('fullnameError').textContent = '';
      sync();
    },
  });
}
