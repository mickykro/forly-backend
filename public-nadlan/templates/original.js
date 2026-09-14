/* Classic: real listing media, gallery navigation, and the approved scroll puzzle.
 * Scalar bindings, translations, leads, analytics and chat use runtime.js. */
(function () {
  'use strict';
  const data = window.__PAGE__ || window.__DEMO__ || {};
  const property = data.property || {}, media = data.hero || {};
  const sections = data.sections || {};
  const playerLabels = {
    he: ['הפעלת הסיור', 'השהיית הסיור'], en: ['Play tour', 'Pause tour'],
    ar: ['تشغيل الجولة', 'إيقاف الجولة مؤقتًا'], ru: ['Включить тур', 'Приостановить тур'],
    fr: ['Lire la visite', 'Mettre en pause'], es: ['Reproducir visita', 'Pausar visita']
  };
  const t = key => key === 'video_play' || key === 'video_pause'
    ? (playerLabels[data.language] || playerLabels.he)[key === 'video_pause' ? 1 : 0]
    : window.I18N.t(data.language || 'he', key);
  const photos = ((data.gallery || {}).images || []).filter(p => p && p.url);
  const captions = (data.gallery || {}).captions || [];
  const heroVideo = document.querySelector('.hero-video');
  const imageHost = document.querySelector('.hero-image');
  const gallery = document.querySelector('#classic-gallery');
  const dialog = document.querySelector('dialog');
  let index = 0;

  document.querySelectorAll('[data-floor]').forEach(el => {
    if (property.floor == null || property.floor === '') el.remove();
  });
  if (!document.querySelector('.hero-facts').children.length) document.querySelector('.hero-facts').hidden = true;
  // Production has no sample-image fallback. Preview media comes only from __DEMO__.
  if (!media.video_url) {
    heroVideo.remove();
    const fallback = media.poster_url || (photos[0] && photos[0].url);
    if (fallback) {
      const img = document.createElement('img');
      img.src = fallback; img.alt = property.title || '';
      imageHost.querySelector('.image-cut').append(img);
    } else {
      imageHost.hidden = true;
      document.querySelector('.hero').classList.add('no-media');
    }
  } else {
    const toggle = document.createElement('button');
    toggle.className = 'hero-video-pause'; toggle.type = 'button';
    function syncVideoButton() {
      toggle.textContent = heroVideo.paused ? '▶' : 'Ⅱ';
      toggle.setAttribute('aria-label', t(heroVideo.paused ? 'video_play' : 'video_pause'));
    }
    toggle.onclick = () => heroVideo.paused ? heroVideo.play().catch(() => {}) : heroVideo.pause();
    heroVideo.addEventListener('play', syncVideoButton);
    heroVideo.addEventListener('pause', syncVideoButton);
    imageHost.append(toggle); syncVideoButton();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) heroVideo.pause();
  }

  function showImage(next) {
    index = (next + photos.length) % photos.length;
    const image = dialog.querySelector('img');
    image.src = photos[index].url;
    image.alt = photos[index].caption || captions[index] || property.title || '';
    dialog.querySelector('.gallery-count').textContent = `${index + 1} / ${photos.length}`;
  }
  photos.forEach((photo, i) => {
    const figure = document.createElement('figure'); figure.className = 'classic-tile';
    const button = document.createElement('button'); button.className = 'photo-button'; button.type = 'button';
    const img = document.createElement('img'); img.src = photo.url; img.loading = 'lazy'; img.decoding = 'async';
    img.alt = photo.caption || captions[i] || property.title || '';
    button.setAttribute('aria-label', `${t('gallery_hint_click')} — ${img.alt}`);
    const zoom = document.createElement('span'); zoom.className = 'zoom-mark'; zoom.textContent = '+'; zoom.setAttribute('aria-hidden', 'true');
    button.append(img, zoom); figure.append(button);
    if (photo.caption || captions[i]) {
      const caption = document.createElement('figcaption'); caption.className = 'photo-caption';
      caption.textContent = photo.caption || captions[i]; figure.append(caption);
    }
    button.onclick = () => { showImage(i); dialog.showModal(); };
    gallery.append(figure);
  });
  if (!photos.length || sections.gallery === false) {
    document.querySelector('.living').hidden = true;
    document.querySelectorAll('a[href="#gallery"]').forEach(el => el.hidden = true);
  }
  dialog.querySelector('.gallery-close').onclick = () => dialog.close();
  dialog.querySelector('.gallery-prev').onclick = () => showImage(index - 1);
  dialog.querySelector('.gallery-next').onclick = () => showImage(index + 1);
  dialog.querySelectorAll('.gallery-prev,.gallery-next').forEach(el => el.hidden = photos.length < 2);
  dialog.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault(); showImage(index + (e.key === 'ArrowRight' ? 1 : -1));
    }
  });
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
  const glimpse = document.querySelector('.glimpse-photo');
  if (photos.length) { glimpse.src = photos[Math.min(1, photos.length - 1)].url; glimpse.alt = property.title || ''; }
  else { glimpse.closest('figure').remove(); document.querySelector('.story-glimpse').classList.add('no-photo'); }
  if (sections.carousel === false) document.querySelector('.facts-section').hidden = true;
  if (sections.area === false) document.querySelector('.detail-grid > div').hidden = true;

  const tour = document.querySelector('#tour'), play = document.querySelector('#play-tour');
  play.textContent = t('video_play');
  if (media.video_url) {
    tour.src = media.video_url;
    if (media.poster_url || photos[0]) tour.poster = media.poster_url || photos[0].url;
    play.onclick = () => tour.paused ? tour.play().catch(() => {}) : tour.pause();
    tour.addEventListener('play', () => { play.textContent = t('video_pause'); if (heroVideo.isConnected) heroVideo.pause(); });
    tour.addEventListener('pause', () => play.textContent = t('video_play'));
    heroVideo.addEventListener('play', () => tour.pause());
  } else document.querySelector('.film-section').hidden = true;

  // runtime.js hides the form after a successful POST (or preview submission).
  const form = document.querySelector('[data-lead-form]');
  new MutationObserver(() => {
    document.querySelector('#classic-lead-sent').hidden = form.style.display !== 'none';
  }).observe(form, { attributes: true, attributeFilter: ['style'] });

// The held edge travels only across the intervening section. No wheel interception.
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const hero=document.querySelector('.hero'),facts=document.querySelector('.facts-section');
const living=document.querySelector('.living'),details=document.querySelector('.detail-section'),film=document.querySelector('.film-section');
// Repeating angular teeth: a half-period horizontal slide produces an exact fit.
const profile1='M-500 20 L-320 20 L-250 60 L-70 60 L0 20 L180 20 L250 60 L430 60 L500 20 L680 20 L750 60 L930 60 L1000 20 L1180 20 L1250 60 L1430 60 L1500 20';
const profile2='M0 15 C200 15 180 80 400 80 C640 80 640 0 820 0 C930 0 940 15 1000 15';
function edge(section,position,profile){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 1000 80');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('aria-hidden','true');svg.classList.add('puzzle-edge','puzzle-'+position);const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',profile+(position==='bottom'?' L1000 -1 L0 -1 Z':' L1000 81 L0 81 Z'));svg.append(path);section.append(svg)}
const profile1Opposite='M0 60 L180 60 L250 20 L430 20 L500 60 L680 60 L750 20 L930 20 L1000 60';
edge(hero,'bottom',profile1);
const slidingEdge=hero.querySelector('.puzzle-bottom');
slidingEdge.style.overflow='hidden';
slidingEdge.style.stroke='var(--paper)';
slidingEdge.style.strokeWidth='1';
const slidingPath=slidingEdge.querySelector('path');
slidingPath.setAttribute('d',profile1+' L1500 -1 L-500 -1 Z');
edge(living,'top',profile1Opposite);edge(living,'bottom',profile2);edge(film,'top',profile2);
if(living.hidden || facts.hidden){hero.querySelector('.puzzle-bottom').style.display='none';living.querySelector('.puzzle-top').style.display='none';}
if(living.hidden || film.hidden){living.querySelector('.puzzle-bottom').style.display='none';film.querySelector('.puzzle-top').style.display='none';}
let ranges=[],pending=false;
function measure(){hero.style.transform='';living.style.transform='';const anchor=Math.min(innerHeight*.25,220);ranges=[[hero,facts,living],[living,details,film]].filter(([upper,middle,lower])=>!upper.hidden&&!lower.hidden&&!middle.hidden).map(([upper,middle,lower])=>{const bottom=upper.getBoundingClientRect().bottom+scrollY;const top=lower.getBoundingClientRect().top+scrollY;return {upper,middle,start:bottom-anchor,distance:Math.max(1,top-bottom)}});render()}
function render(){pending=false;for(const r of ranges){const progress=reduced.matches?0:Math.min(1,Math.max(0,(scrollY-r.start)/r.distance));r.upper.style.transform=`translateY(${progress*r.distance}px)`;r.middle.style.opacity=String(1-Math.max(0,(progress-.25)/.75));r.middle.inert=progress>.98;r.middle.dataset.covered=String(progress>.98);if(r.upper===hero)slidingPath.setAttribute('transform',`translate(${-250*progress} 0)`)}}
addEventListener('scroll',()=>{if(!pending){pending=true;requestAnimationFrame(render)}},{passive:true});addEventListener('resize',measure);reduced.addEventListener('change',measure);
const revealTargets=document.querySelectorAll('.living-head,.gallery-composition,.detail-grid,.film-head,.film-stage,.contact-grid');
if(!reduced.matches){document.documentElement.classList.add('motion-ready');const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('revealed');observer.unobserve(entry.target)}}),{threshold:.08});revealTargets.forEach(el=>{el.dataset.reveal='';observer.observe(el)})}
// Re-measure after local fonts load so long Hebrew headings cannot shift the joins.
document.fonts.ready.then(measure);addEventListener('load',measure);measure();

new ResizeObserver(()=>requestAnimationFrame(measure)).observe(document.querySelector("main"));
})();
