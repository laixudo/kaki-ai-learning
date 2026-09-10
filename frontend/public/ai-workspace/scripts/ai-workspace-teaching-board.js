(function(root,factory){
  var api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  if(root) root.KakiTeachingBoard=api;
}(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  var TEMPLATES=Object.freeze(['bullet_slide','step_explanation','formula_board','comparison_board','flow','timeline','worked_example','mini_demo']);
  function text(v){return String(v==null?'':v).trim();}
  function cleanLines(value){return text(value).split(/\n+/).map(function(line){return line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/,'').trim();}).filter(Boolean);}
  function chooseTemplate(content,context){
    var value=text(content); var action=text(context&&context.action);
    // Pedagogical intent wins over broad subject words such as “函数”.
    if(action==='misconception_distinction'||/区别|对比|相同|不同/.test(value)) return 'comparison_board';
    if(/时间线|时间轴|先后顺序|阶段|历程|演变/.test(value)) return 'timeline';
    if(action==='transfer_challenge'||/迁移|流程|先.*再|然后/.test(value)) return 'flow';
    if(/例题|例如|举个例|示范/.test(value)) return 'worked_example';
    if(/(?:公式|方程)\s*[:：]?\s*[^。！？]*[=＋+\-×÷*/^]|[^。！？]+=[^。！？]+|\$[^$]+\$/.test(value)) return 'formula_board';
    if(/第[一二三四五12345]步|步骤|一步/.test(value)) return 'step_explanation';
    if(/演示|变化|观察/.test(value)) return 'mini_demo';
    return 'bullet_slide';
  }
  function payloadFor(template,content,context){
    var lines=cleanLines(content); var title=text(context&&context.title)||'柿小吉的即时板书';
    var first=lines[0]||text(content).slice(0,80)||'我们先把关键点放到黑板上。';
    if(template==='formula_board') return {title:title,formula:(text(content).match(/[^。！？\n]{0,50}[=＋+\-×÷*/^][^。！？\n]{0,60}/)||[])[0]||first,notes:lines.slice(0,3)};
    if(template==='comparison_board') return {title:title,left:{label:'先看这一边',items:lines.slice(0,2)},right:{label:'再对照这一边',items:lines.slice(2,4).length?lines.slice(2,4):[first]}};
    if(template==='flow') return {title:title,steps:(lines.length?lines:[first]).slice(0,5)};
    if(template==='timeline') return {title:title,steps:(lines.length?lines:[first]).slice(0,5)};
    if(template==='worked_example') return {title:title,prompt:first,steps:(lines.slice(1).length?lines.slice(1):['先找已知条件','再选择对应规则','最后检查结果']).slice(0,4)};
    if(template==='mini_demo') return {title:title,caption:first,values:[28,54,76,43,68]};
    if(template==='step_explanation') return {title:title,steps:(lines.length?lines:[first]).slice(0,5)};
    return {title:title,items:(lines.length?lines:[first]).slice(0,5)};
  }
  function createElement(doc,tag,cls,content){var el=doc.createElement(tag);if(cls)el.className=cls;if(content!=null)el.textContent=text(content);return el;}
  function createRenderer(host,options){
    options=options||{}; var doc=host.ownerDocument; var current={template:'',payload:null,step:0};
    function signal(step){var nodes=Array.prototype.slice.call(host.querySelectorAll('[data-step]'));var index=Math.max(0,Number(step)||0);current.step=index;if(typeof options.onStep==='function')options.onStep({template:current.template,step:index,total:Math.max(1,nodes.length),target:{kind:'board_step',step:index}});}
    function skeleton(template,title){host.innerHTML='';host.dataset.template=template;host.dataset.phase='skeleton';var head=createElement(doc,'header','kaki-board-head');head.append(createElement(doc,'small','', '即时教学板书'),createElement(doc,'strong','',title||'正在准备板书…'));host.appendChild(head);var body=createElement(doc,'div','kaki-board-body');body.appendChild(createElement(doc,'p','kaki-board-skeleton','先把结构放出来，内容会和讲解一起补齐。'));host.appendChild(body);}
    function render(template,payload){
      if(TEMPLATES.indexOf(template)<0) template='bullet_slide'; current={template:template,payload:payload||{},step:0};
      host.innerHTML='';host.dataset.template=template;host.dataset.phase='content';var head=createElement(doc,'header','kaki-board-head');head.append(createElement(doc,'small','', '即时教学板书'),createElement(doc,'strong','',payload.title||'柿小吉的板书'));host.appendChild(head);var body=createElement(doc,'div','kaki-board-body');
      if(template==='bullet_slide'){
        var ul=createElement(doc,'ul','kaki-board-list');(payload.items||[]).forEach(function(item,i){var li=createElement(doc,'li','kaki-board-step',item);li.dataset.step=String(i);ul.appendChild(li);});body.appendChild(ul);
      }else if(template==='step_explanation'||template==='flow'||template==='timeline'){
        var flow=createElement(doc,'ol',template==='flow'?'kaki-board-flow':(template==='timeline'?'kaki-board-timeline':'kaki-board-steps'));(payload.steps||[]).forEach(function(item,i){var li=createElement(doc,'li','kaki-board-step',item);li.dataset.step=String(i);flow.appendChild(li);});body.appendChild(flow);
      }else if(template==='formula_board'){
        body.append(createElement(doc,'div','kaki-board-formula',payload.formula||''));var notes=createElement(doc,'ul','kaki-board-list');(payload.notes||[]).forEach(function(n,i){var li=createElement(doc,'li','kaki-board-step',n);li.dataset.step=String(i);notes.appendChild(li);});body.appendChild(notes);
      }else if(template==='comparison_board'){
        var grid=createElement(doc,'div','kaki-board-compare');[payload.left||{},payload.right||{}].forEach(function(side,sideIndex){var col=createElement(doc,'section','');col.appendChild(createElement(doc,'strong','',side.label||'对照'));(side.items||[]).forEach(function(item,i){var p=createElement(doc,'p','kaki-board-step',item);p.dataset.step=String(sideIndex*2+i);col.appendChild(p);});grid.appendChild(col);});body.appendChild(grid);
      }else if(template==='worked_example'){
        body.append(createElement(doc,'p','kaki-board-problem',payload.prompt||''));var steps=createElement(doc,'ol','kaki-board-steps');(payload.steps||[]).forEach(function(item,i){var li=createElement(doc,'li','kaki-board-step',item);li.dataset.step=String(i);steps.appendChild(li);});body.appendChild(steps);
      }else if(template==='mini_demo'){
        body.append(createElement(doc,'p','kaki-board-caption',payload.caption||''));var demo=createElement(doc,'div','kaki-board-demo');(payload.values||[]).forEach(function(v,i){var bar=createElement(doc,'span','kaki-board-demo-bar');bar.style.setProperty('--demo-value',Math.max(8,Math.min(100,Number(v)||10))+'%');bar.dataset.step=String(i);demo.appendChild(bar);});body.appendChild(demo);
      }
      host.appendChild(body); highlight(0); return current;
    }
    function highlight(step){var index=Number(step)||0;signal(index);var nodes=Array.prototype.slice.call(host.querySelectorAll('[data-step]'));nodes.forEach(function(node){node.classList.toggle('is-active',Number(node.dataset.step)===index);});}
    function progress(content,context){var template=chooseTemplate(content,context);var payload=payloadFor(template,content,context);if(current.template!==template) skeleton(template,payload.title);return render(template,payload);}
    return {templates:TEMPLATES.slice(),skeleton:skeleton,render:render,progress:progress,highlight:highlight,getState:function(){return Object.assign({},current);},clear:function(){host.innerHTML='';host.dataset.phase='empty';current={template:'',payload:null,step:0};}};
  }
  return {TEMPLATES:TEMPLATES,chooseTemplate:chooseTemplate,payloadFor:payloadFor,createRenderer:createRenderer};
}));
