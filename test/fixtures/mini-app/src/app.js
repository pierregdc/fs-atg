const form = document.querySelector('#task-form');
const input = document.querySelector('#task-input');
const list = document.querySelector('#task-list');
const emptyState = document.querySelector('#empty-state');

function renderTask(label) {
  const item = document.createElement('li');
  item.className = 'task-item';
  item.textContent = label;
  list.append(item);
  emptyState.hidden = true;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const label = input.value.trim();
  if (!label) return;
  renderTask(label);
  input.value = '';
  input.focus();
});

// TODO: Persist tasks in localStorage.
