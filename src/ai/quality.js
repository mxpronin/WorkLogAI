function words(value) {
  return String(value ?? '').toLocaleLowerCase('ru-RU').match(/[a-zа-яё0-9]+/giu) ?? [];
}

export function isSuperficialImprovement(source, improved) {
  const sourceWords = words(source);
  const improvedWords = words(improved);
  if (!sourceWords.length || !improvedWords.length) return true;

  const sourceVocabulary = new Set(sourceWords);
  const addedWords = new Set(improvedWords.filter((word) => !sourceVocabulary.has(word)));
  const lengthGrowth = improvedWords.length / sourceWords.length;
  const sentenceCount = (String(improved).match(/[.!?](?:\s|$)/g) ?? []).length;
  const requiredAddedWords = sourceWords.length < 8 ? 4 : Math.max(4, Math.ceil(sourceWords.length * 0.2));

  return addedWords.size < requiredAddedWords && lengthGrowth < 1.35 && sentenceCount < 2;
}
