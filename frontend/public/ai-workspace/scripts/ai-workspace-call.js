(function(root,factory){
  var api=factory(root);
  if(typeof module==='object'&&module.exports) module.exports=api;
  if(root) root.KakiVoiceCallRuntime=api;
}(typeof window!=='undefined'?window:globalThis,function(env){
  'use strict';
  var CALL_STATES=['idle','requesting_permission','listening','recognizing','thinking','speaking','teaching','interrupted','muted','paused','ended','recoverable_error'];
  var state='idle', active=false, micMuted=false, outputMuted=false, recognition=null, avatar=null, board=null, callContext=null, prewarmed=null;
  var speechQueue=[], speakingQueue=false, speechBuffer='', lastAssistant='', lastUser='', lastBoardText='', recognitionGeneration=0;
  var formalSendInFlight=false, speechStartedThisTurn=false, firstAssistantChunkSeen=false, bridgeTimer=null, turnCounter=0, finalizedTurns=[], finalizedDrain=null, ending=false, stopPromise=null, teachingAttentionTimer=null;
  var rootEl=null, avatarHost=null, bubbleEl=null, stateEl=null, transcriptEl=null, recoveryEl=null, recoveryActionsEl=null, boardEl=null, textFallback=null;
  var speech=env.speechAdapter;
  var directButton=null, directButtonHandler=null;
  // Backend-ASR capture state (MediaRecorder + VAD -> /api/chat/input/transcribe).
  var capStream=null, capRecorder=null, capAudioCtx=null, capAnalyser=null, capVadTimer=null, capGeneration=0;
  var capSpeechSeen=false, capLastSpeechAt=0, capStartedAt=0, capChunks=[], capBusy=false, capMime='', lastCaptureError=null;

  function bridge(){return env.KakiWorkspaceRuntimeBridge||null;}
  function el(tag,cls,text){var n=env.document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=String(text);return n;}
  // 数字人收口：通话状态只呈现一张正面固定形象 + 轻量反馈（CSS 驱动），
  // 不再挂载第二套数字人容器；语音播放仍走真实 audio 通道。
  function createFixedImageAvatar(host){
    var doc=env.document;
    host.innerHTML='';
    host.dataset.renderer='fixed_front_image';
    host.dataset.avatarState='idle';
    var img=doc.createElement('img');
    img.className='voice-call-avatar-image';
    img.src='/ai-workspace/assets/avatars/kaki-companion-front.png';
    img.alt='柿小吉';
    img.draggable=false;
    var audio=doc.createElement('audio');
    audio.className='kaki-avatar-audio-channel';
    audio.hidden=true;
    audio.preload='auto';
    audio.setAttribute('aria-hidden','true');
    host.append(img,audio);
    var state='idle', speaking=false, teaching=false;
    function sync(){host.dataset.avatarState=speaking?'speaking':(teaching?'teaching':state);}
    return {
      renderer_kind:'fixed_front_image',
      setState:function(next){state=String(next||'idle');sync();return state;},
      setSpeechActive:function(active){speaking=Boolean(active);sync();},
      setSpeechEnvelope:function(){},
      setTeaching:function(active){teaching=Boolean(active);sync();},
      setAttention:function(){},setTeachingTarget:function(){return null;},setGesture:function(){},lookAtUser:function(){},setGaze:function(){},
      interrupt:function(){speaking=false;state='interrupted';sync();if(audio&&!audio.paused){try{audio.pause();audio.currentTime=0;}catch(_){}}},
      getAudioElement:function(){return audio;},
      getState:function(){return {state:state,speech_active:speaking,teaching:teaching,renderer_kind:'fixed_front_image',model_ready:true,asset_status:'ready'};},
      getAssetStatus:function(){return 'ready';},
      ready:function(){return Promise.resolve(true);},
      isModelReady:function(){return true;},
      destroy:function(){try{if(audio){audio.pause();audio.removeAttribute('src');audio.load();}}catch(_){}host.innerHTML='';}
    };
  }
  // Assistant text is authored in markdown/LaTeX for the chat renderer; the
  // call overlay (bubble, transcript, teaching board) shows plain text, so
  // strip the authoring syntax instead of leaking raw `**` and `\( \)`.
  var LATEX_SYMBOLS={triangle:'△',angle:'∠',times:'×',cdot:'·',div:'÷',leq:'≤',geq:'≥',neq:'≠',pm:'±',sqrt:'√',pi:'π',degree:'°',circ:'°',approx:'≈',infty:'∞',alpha:'α',beta:'β',gamma:'γ',theta:'θ',lambda:'λ',mu:'μ',Delta:'Δ',Omega:'Ω'};
  function cleanDisplayText(text){
    var value=String(text||'');
    value=value.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g,'$1/$2');
    value=value.replace(/\\[\(\)\[\]]/g,'');
    value=value.replace(/\\(triangle|angle|times|cdot|div|leq|geq|neq|pm|sqrt|pi|degree|circ|approx|infty|alpha|beta|gamma|theta|lambda|mu|Delta|Omega)\b/g,function(match,name){return LATEX_SYMBOLS[name]||'';});
    value=value.replace(/\\[a-zA-Z]+/g,'');
    value=value.replace(/[{}]/g,'');
    value=value.replace(/\*\*([^*]+)\*\*/g,'$1');
    value=value.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g,'$1$2');
    value=value.replace(/__([^_]+)__/g,'$1');
    value=value.replace(/`([^`]+)`/g,'$1');
    value=value.replace(/^#{1,6}\s+/gm,'');
    return value;
  }
  function labelFor(s){return ({idle:'待机',requesting_permission:'正在请求麦克风',listening:'正在听你说',recognizing:'正在识别',thinking:'正在思考',speaking:'正在回答',teaching:'正在讲解',interrupted:'已打断',muted:'麦克风已静音',paused:'已暂停',ended:'通话已结束',recoverable_error:'需要你处理一下'})[s]||s;}
  function avatarStateFor(s){return ({requesting_permission:'listening',listening:'listening',recognizing:'thinking',thinking:'thinking',speaking:'speaking',teaching:'explaining',interrupted:'interrupted',muted:'listening',recoverable_error:'encouraging'})[s]||'idle';}
  function setState(next,detail){if(CALL_STATES.indexOf(next)<0)next='idle';state=next;if(rootEl)rootEl.dataset.state=state;if(stateEl)stateEl.textContent=labelFor(state);if(avatar)avatar.setState(avatarStateFor(state));if(detail&&bubbleEl)bubbleEl.textContent=cleanDisplayText(detail);return state;}
  function appendTranscript(role,text){if(!transcriptEl||!String(text||'').trim())return;var p=el('p','');var who=el('b','',role==='user'?'你：':'柿小吉：');p.append(who,env.document.createTextNode(cleanDisplayText(text).trim()));transcriptEl.appendChild(p);while(transcriptEl.children.length>16)transcriptEl.removeChild(transcriptEl.firstChild);transcriptEl.scrollTop=transcriptEl.scrollHeight;}
  function setRecovery(message,mode){if(!recoveryEl)return;recoveryEl.textContent=message||'';recoveryEl.hidden=!message;if(recoveryActionsEl)recoveryActionsEl.hidden=!message||mode!=='permission';}
  function clearBridgeTimer(){if(bridgeTimer){(env.clearTimeout||clearTimeout)(bridgeTimer);bridgeTimer=null;}}
  function clearTeachingAttentionTimer(){if(teachingAttentionTimer){(env.clearTimeout||clearTimeout)(teachingAttentionTimer);teachingAttentionTimer=null;}}
  function delay(ms){return new Promise(function(resolve){(env.setTimeout||setTimeout)(resolve,Math.max(0,Number(ms)||0));});}
  async function waitForFormalIdle(timeoutMs){var b=bridge(),started=Date.now(),limit=Math.max(250,Number(timeoutMs)||30000);while(b&&b.isConversationBusy&&b.isConversationBusy()){if(Date.now()-started>=limit)throw new Error('等待正式 Conversation 落盘超时。');await delay(50);}return true;}

  function bridgePhrase(){var action=callContext&&callContext.tutor_public&&callContext.tutor_public.action||'';if(action==='misconception_distinction')return '这个我换个角度给你看。';if(action==='reteach_scaffold')return '我想一下怎么讲得更清楚。';return '我大概知道你卡在哪里了。';}
  function scheduleNaturalBridge(){clearBridgeTimer();turnCounter+=1;if(turnCounter%3!==1)return;bridgeTimer=(env.setTimeout||setTimeout)(function(){bridgeTimer=null;if(active&&formalSendInFlight&&!firstAssistantChunkSeen&&state==='thinking'&&bubbleEl)bubbleEl.textContent=bridgePhrase();},900);}
  function setTeaching(activeTeaching){if(!rootEl)return;clearTeachingAttentionTimer();rootEl.dataset.teaching=activeTeaching?'true':'false';if(avatar){avatar.setTeaching(activeTeaching);if(activeTeaching&&avatar.setAttention)avatar.setAttention('ATTENTION_BOARD');if(!activeTeaching&&avatar.lookAtUser)avatar.lookAtUser();}if(activeTeaching&&state==='speaking')setState('teaching',bubbleEl&&bubbleEl.textContent||'');}
  function focusTeachingStep(info){if(!avatar||!rootEl||rootEl.dataset.teaching!=='true')return;clearTeachingAttentionTimer();if(avatar.setAttention)avatar.setAttention('ATTENTION_BOARD');if(avatar.setTeachingTarget)avatar.setTeachingTarget({step:info&&info.step||0,total:info&&info.total||5,target:info&&info.target||null});else avatar.setGesture('point',{step:info&&info.step||0,total:info&&info.total||5});teachingAttentionTimer=(env.setTimeout||setTimeout)(function(){teachingAttentionTimer=null;if(active&&avatar&&avatar.lookAtUser)avatar.lookAtUser();},520);}

  function likelyTeaching(textValue){var text=String(textValue||'');var action=callContext&&callContext.tutor_public&&callContext.tutor_public.action||'';return ['reteach_scaffold','misconception_distinction','transfer_challenge'].indexOf(action)>=0||/步骤|例题|例如|公式|对比|区别|流程|迁移|演示|为什么/.test(text);}
  function updateBoard(fullText){if(!board||!fullText||fullText===lastBoardText)return;if(!likelyTeaching(fullText))return;lastBoardText=fullText;setTeaching(true);var current=callContext&&callContext.current_object||{};board.progress(cleanDisplayText(fullText),{action:callContext&&callContext.tutor_public&&callContext.tutor_public.action||'',title:current.title||'当前知识点'});}
  function nextSpeech(){
    if(!active||ending||outputMuted||speakingQueue||!speechQueue.length)return;
    if(!speech||!speech.supported()){setRecovery('柿小吉的声音暂时不可用，先用文字和板书继续。');return;}
    var segment=speechQueue.shift(); speakingQueue=true; speechStartedThisTurn=true; setState(rootEl&&rootEl.dataset.teaching==='true'?'teaching':'speaking',segment);
    speech.speak(segment,{preset:rootEl&&rootEl.dataset.teaching==='true'?'teaching':'call',
      onStart:function(){setRecovery('');if(avatar)avatar.setSpeechActive(true);},
      onBoundary:function(event){if(board){var total=Math.max(1,segment.length);var step=Math.min(4,Math.floor(Number(event.charIndex||0)/total*5));board.highlight(step);}},
      onPause:function(){if(avatar)avatar.setSpeechActive(false);},onResume:function(){if(avatar)avatar.setSpeechActive(true);},
      onEnd:function(){speakingQueue=false;if(avatar)avatar.setSpeechActive(false);if(ending)return;if(speechQueue.length)nextSpeech();else if(formalSendInFlight){setState(rootEl&&rootEl.dataset.teaching==='true'?'teaching':'thinking','我还在继续组织后面的内容…');}else if(active&&!micMuted){setTeaching(false);startListening();}},
      onError:function(){speakingQueue=false;speechQueue=[];if(avatar)avatar.setSpeechActive(false);if(active&&!ending&&!micMuted)startListening();setRecovery('柿小吉的声音暂时没有连上，回答已留在文字和板书里；声音恢复后会自动回来。');}
    });
  }
  function enqueueSpeech(text){if(outputMuted)return;var parts=env.AIWorkspaceSpeech?env.AIWorkspaceSpeech.prepareSpeechSegments(text,120):[String(text||'')];parts.filter(Boolean).forEach(function(part){speechQueue.push(part);});nextSpeech();}
  function flushSpeechBuffer(force){var value=speechBuffer;if(!value)return;var last=Math.max(value.lastIndexOf('。'),value.lastIndexOf('！'),value.lastIndexOf('？'),value.lastIndexOf('；'))+1;if(last>9||force){var cut=last>9?last:value.length;var segment=value.slice(0,cut);speechBuffer=value.slice(cut);enqueueSpeech(segment);}}
  function stopSpeech(interrupted){speechQueue=[];speechBuffer='';speakingQueue=false;clearTeachingAttentionTimer();if(speech)speech.stop();if(avatar){if(avatar.interrupt)avatar.interrupt();else{avatar.setSpeechActive(false);if(avatar.setSpeechEnvelope)avatar.setSpeechEnvelope(0);}}if(interrupted)setState('interrupted','好，我停下来了。你可以直接说。');}
  function stopCapture(){
    recognitionGeneration+=1;
    if(recognition){try{recognition.abort();}catch(ignore){}recognition=null;}
    capGeneration+=1;
    if(capVadTimer){(env.clearInterval||clearInterval)(capVadTimer);capVadTimer=null;}
    if(capRecorder){try{if(capRecorder.state!=='inactive')capRecorder.stop();}catch(ignore){}capRecorder=null;}
    capChunks=[];
    if(capStream){try{capStream.getTracks().forEach(function(track){track.stop();});}catch(ignore){}capStream=null;}
    if(capAudioCtx){try{capAudioCtx.close();}catch(ignore){}capAudioCtx=null;capAnalyser=null;}
    capSpeechSeen=false;capBusy=false;
  }
  function stopRecognition(){stopCapture();}
  function recognitionConstructor(){return env.SpeechRecognition||env.webkitSpeechRecognition||null;}
  function backendAsrAvailable(){var b=bridge();var inputs=b&&b.getInputCapabilities?b.getInputCapabilities():{};return Boolean(inputs&&inputs.backendAsr)&&b&&typeof b.transcribeAudio==='function'&&env.navigator&&env.navigator.mediaDevices&&typeof env.navigator.mediaDevices.getUserMedia==='function'&&typeof env.MediaRecorder==='function';}
  function capabilities(){var b=bridge();var inputs=b&&b.getInputCapabilities?b.getInputCapabilities():{};var persona=speech&&speech.getPersona?speech.getPersona():null;var media=env.navigator&&env.navigator.mediaDevices;var avatarState=avatar&&avatar.getState?avatar.getState():{};return {call_asr_engine:backendAsrAvailable()?'backend_faster_whisper':(recognitionConstructor()?'browser_web_speech':'none'),browser_asr:Boolean(recognitionConstructor()),browser_mic:Boolean(media&&typeof media.getUserMedia==='function'),backend_asr:Boolean(inputs&&inputs.backendAsr),tts_available:Boolean(speech&&speech.supported()),browser_tts:Boolean(speech&&speech.browserSupported?speech.browserSupported():speech&&speech.supported()),browser_voice_available:Boolean(persona&&persona.browser_voice_uri),real_voice_provider_status:speech&&speech.getProviderStatus?speech.getProviderStatus():'REAL_VOICE_PROVIDER_BLOCKED',voice_persona:persona,avatar_renderer:avatarState&&avatarState.renderer_kind||'fixed_front_image',animatable_asset_ready:false,animatable_asset_status:'superseded_by_fixed_front_image',live2d_model_ready:false,live2d_asset_status:'superseded_by_fixed_front_image'};}
  async function checkReadiness(){
    var result=Object.assign({},capabilities(),{secure_context:Boolean(env.isSecureContext),microphone_permission:'unknown',audio_input_count:null,checked_at:new Date().toISOString()});
    try{if(env.navigator&&env.navigator.permissions&&env.navigator.permissions.query){var permission=await env.navigator.permissions.query({name:'microphone'});result.microphone_permission=permission&&permission.state||'unknown';}}catch(ignore){result.microphone_permission='unsupported';}
    try{var media=env.navigator&&env.navigator.mediaDevices;if(media&&typeof media.enumerateDevices==='function'){var devices=await media.enumerateDevices();result.audio_input_count=devices.filter(function(device){return device.kind==='audioinput';}).length;}}catch(ignore){result.audio_input_count=null;}
    result.ready_for_voice_attempt=Boolean(result.secure_context&&result.browser_mic&&result.call_asr_engine!=='none');
    result.text_fallback_available=Boolean(textFallback);
    return result;
  }
  function startListening(){
    if(!active||micMuted)return;stopCapture();
    if(backendAsrAvailable()){startBackendListening();return;}
    startBrowserListening();
  }
  // Primary engine: real microphone -> MediaRecorder -> backend faster-whisper
  // -> one finalized utterance -> the single formal Conversation.  Browser Web
  // Speech proved unreliable on the accepted Windows runtime, so the call now
  // uses the same authenticated transcribe adapter as the composer.  There is
  // no interim text on this path; only the finalized utterance is submitted.
  function startBackendListening(){
    lastCaptureError=null;setRecovery('');setState('requesting_permission','正在连接麦克风…');var generation=++capGeneration;
    env.navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}}).then(function(stream){
      if(!active||generation!==capGeneration){stream.getTracks().forEach(function(t){t.stop();});return;}
      capStream=stream;capChunks=[];capSpeechSeen=false;capLastSpeechAt=0;capBusy=false;
      var types=['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'];
      capMime='';for(var i=0;i<types.length;i++){if(env.MediaRecorder.isTypeSupported(types[i])){capMime=types[i];break;}}
      capRecorder=capMime?new env.MediaRecorder(stream,{mimeType:capMime}):new env.MediaRecorder(stream);
      capRecorder.ondataavailable=function(event){if(event.data&&event.data.size)capChunks.push(event.data);};
      capRecorder.onstop=function(){
        if(generation!==capGeneration)return;
        var chunks=capChunks;capChunks=[];var heard=capSpeechSeen;capSpeechSeen=false;
        if(capStream){try{capStream.getTracks().forEach(function(t){t.stop();});}catch(ignore){}capStream=null;}
        if(capAudioCtx){try{capAudioCtx.close();}catch(ignore){}capAudioCtx=null;capAnalyser=null;}
        if(!active||!heard||!chunks.length){if(active&&!micMuted)startListening();return;}
        var type=(capRecorder&&capRecorder.mimeType)||capMime||'audio/webm';
        var blob=new Blob(chunks,{type:type.split(';')[0]});
        var ext=type.indexOf('ogg')>=0?'.ogg':(type.indexOf('mp4')>=0?'.mp4':'.webm');
        transcribeCapture(blob,'call-utterance'+ext,generation);
      };
      try{
        capAudioCtx=new (env.AudioContext||env.webkitAudioContext)();
        var source=capAudioCtx.createMediaStreamSource(stream);
        capAnalyser=capAudioCtx.createAnalyser();capAnalyser.fftSize=512;source.connect(capAnalyser);
      }catch(ignore){capAnalyser=null;}
      capStartedAt=Date.now();capRecorder.start(250);
      setState('listening','我在听，你直接说就好。');
      var buf=capAnalyser?new Uint8Array(capAnalyser.fftSize):null;
      capVadTimer=(env.setInterval||setInterval)(function(){
        if(!active||generation!==capGeneration||!capRecorder||capRecorder.state==='inactive')return;
        var now=Date.now();var level=0;
        if(capAnalyser&&buf){capAnalyser.getByteTimeDomainData(buf);var sum=0;for(var j=0;j<buf.length;j++){var v=(buf[j]-128)/128;sum+=v*v;}level=Math.sqrt(sum/buf.length);}
        var speaking=level>0.02;
        if(speaking){capLastSpeechAt=now;if(!capSpeechSeen){capSpeechSeen=true;setState('recognizing','正在听你说…');}}
        var longEnough=now-capStartedAt>=600;
        if(capSpeechSeen&&longEnough&&now-capLastSpeechAt>1400){finishCaptureTurn();return;}
        if(!capSpeechSeen&&now-capStartedAt>60000){capChunks=[];capStartedAt=now;try{capRecorder.stop();}catch(ignore){}return;}
      },100);
    }).catch(function(error){
      if(!active||generation!==capGeneration)return;
      var name=error&&error.name||'UnknownError';lastCaptureError={name:name,message:error&&error.message||''};
      if(name==='NotAllowedError'||name==='SecurityError'){
        setState('recoverable_error','麦克风权限没有开启。');setRecovery('请允许麦克风权限后重新授权，或使用文字继续当前通话。','permission');
      }else if(name==='NotFoundError'||name==='DevicesNotFoundError'){
        setState('recoverable_error','没有找到可用的麦克风。');setRecovery('请连接或启用麦克风后重试，或使用文字继续当前通话。','permission');
      }else if(name==='NotReadableError'||name==='TrackStartError'){
        setState('recoverable_error','麦克风当前无法读取。');setRecovery('麦克风可能正被其他程序占用；请关闭占用后重试，或使用文字继续。','permission');
      }else{
        setState('recoverable_error','麦克风暂时无法启动。');setRecovery('请检查麦克风设备与浏览器权限后重试，或使用文字继续。','permission');
      }
    });
  }
  function finishCaptureTurn(){if(capRecorder&&capRecorder.state!=='inactive'){try{capRecorder.stop();}catch(ignore){}}}
  async function transcribeCapture(blob,fileName,generation){
    if(capBusy)return;capBusy=true;setState('recognizing','正在转写你刚才说的话…');
    try{
      var b=bridge();var response=await b.transcribeAudio(blob,fileName);
      if(!active||generation!==capGeneration)return;
      var text=response&&response.data&&String(response.data.text||'').trim();
      if(text){submitUtterance(text);}
      else{setState('listening','没有听清，可以再说一次。');setRecovery('上一句没有识别出内容，请靠近麦克风再说一次。');startListening();}
    }catch(error){
      if(!active||generation!==capGeneration)return;
      setState('recoverable_error','语音转写暂时不可用。');setRecovery('可以重试语音，或使用文字继续通话。');
    }finally{capBusy=false;}
  }
  function startBrowserListening(){
    var Recognition=recognitionConstructor();
    if(!Recognition){setState('recoverable_error','当前浏览器没有连续语音识别能力，可以先用下方文字继续通话。');setRecovery('连续 ASR 当前不可用；没有用 mock transcript 冒充识别结果。','permission');return;}
    setRecovery('');setState('requesting_permission','正在连接麦克风…');var generation=recognitionGeneration;var r=new Recognition();recognition=r;r.lang='zh-CN';r.continuous=true;r.interimResults=true;var finalText='';
    r.onstart=function(){if(!active||generation!==recognitionGeneration)return;setState('listening','我在听，你直接说就好。');};
    r.onresult=function(event){if(!active||generation!==recognitionGeneration)return;var interim='';for(var i=event.resultIndex||0;i<event.results.length;i++){var part=event.results[i][0]&&event.results[i][0].transcript||'';if(event.results[i].isFinal)finalText+=part;else interim+=part;}if(interim){setState('recognizing',interim);if(bubbleEl)bubbleEl.textContent=interim;}if(finalText.trim()){var value=finalText.trim();finalText='';stopCapture();submitUtterance(value);}};
    r.onerror=function(event){if(!active)return;recognition=null;var code=event&&event.error||'unknown';setState('recoverable_error',code==='not-allowed'?'麦克风权限没有开启。':'语音识别暂时不可用。');setRecovery(code==='not-allowed'?'请允许麦克风权限后重新授权，或使用文字继续当前通话。':'可以重试语音，或使用文字继续通话。',code==='not-allowed'?'permission':'');};
    r.onend=function(){if(recognition===r)recognition=null;if(active&&!micMuted&&state==='listening')env.setTimeout(function(){if(active&&!recognition)startListening();},220);};
    try{r.start();}catch(error){recognition=null;setState('recoverable_error','麦克风暂时无法启动。');setRecovery('请检查浏览器麦克风权限，重新授权，或使用文字继续。','permission');}
  }
  function queueFinalizedTurn(value){var text=String(value||'').trim();if(!text)return Promise.resolve(false);finalizedTurns.push({text:text,created_at:Date.now()});return drainFinalizedTurns(false);}
  function drainFinalizedTurns(force){
    if(finalizedDrain)return finalizedDrain;
    finalizedDrain=(async function(){var b=bridge();if(!b||!b.sendVoiceMessage)throw new Error('正式消息入口尚未就绪。');while(finalizedTurns.length){if(!active&&!force)break;await waitForFormalIdle(30000);var turn=finalizedTurns[0];await Promise.resolve(b.sendVoiceMessage(turn.text));await waitForFormalIdle(45000);finalizedTurns.shift();}return finalizedTurns.length===0;})().catch(function(error){setRecovery(error&&error.message||'最后一句暂未写入正式会话。');setState('recoverable_error','最后一句还没有安全写入会话。');return false;}).finally(function(){finalizedDrain=null;});
    return finalizedDrain;
  }
  function sendWhenFormalIdle(value){return queueFinalizedTurn(value);}
  function submitUtterance(text){var value=String(text||'').trim();if(!value||!active||ending)return Promise.resolve(false);lastUser=value;appendTranscript('user',value);setState('thinking','我听到了，正在结合当前学习内容回答。');return sendWhenFormalIdle(value);}
  function interruptCall(){stopSpeech(true);setTeaching(false);var b=bridge();if(b&&b.abortFormalSend)b.abortFormalSend();var wait=function(attempt){if(!active||ending||micMuted)return;if(b&&b.isConversationBusy&&b.isConversationBusy()&&(attempt||0)<30)return (env.setTimeout||setTimeout)(function(){wait((attempt||0)+1);},50);startListening();};wait(0);}
  function buildUi(){
    if(rootEl||!env.document)return;var app=env.document.getElementById('workspaceApp')||env.document.getElementById('app');if(!app)return;
    rootEl=el('section','voice-call-shell');rootEl.id='kakiVoiceCall';rootEl.hidden=true;rootEl.dataset.state='idle';rootEl.dataset.teaching='false';rootEl.setAttribute('aria-label','与柿小吉连续语音通话');
    var head=el('header','voice-call-head');var copy=el('div','voice-call-head-copy');copy.append(el('strong','','柿小吉 · 连续通话'),el('small','','同一会话 · 同一 AI 导师 · 语音文字都会进入当前学习上下文'));stateEl=el('span','voice-call-state','待机');var controls=el('div','voice-call-controls');
    var mute=el('button','','静音麦克风');mute.id='voiceCallMute';mute.onclick=function(){micMuted=!micMuted;if(micMuted){stopSpeech(true);setTeaching(false);stopRecognition();if(avatar)avatar.setState('listening');setState('muted','麦克风已静音；AI 播放、嘴型和讲师动作已停止。');mute.textContent='取消静音';}else{mute.textContent='静音麦克风';startListening();}};
    var outputMute=el('button','','关闭声音');outputMute.id='voiceCallOutputMute';outputMute.onclick=function(){outputMuted=!outputMuted;if(outputMuted){stopSpeech(true);setTeaching(false);outputMute.textContent='开启声音';if(!micMuted)setState('listening','声音已关闭，我继续听你说。');setRecovery('AI 声音已关闭，文字和板书继续正常更新。');}else{outputMute.textContent='关闭声音';setRecovery('');if(!micMuted)startListening();}};
    var replay=el('button','','重听');replay.id='voiceCallReplay';replay.onclick=function(){if(lastAssistant&&!ending){stopSpeech(false);enqueueSpeech(lastAssistant);}};
    var end=el('button','voice-call-end','结束通话');end.id='voiceCallEnd';end.onclick=function(){stop('user_hangup');};controls.append(mute,outputMute,replay,end);head.append(copy,stateEl,controls);
    var body=el('div','voice-call-body');boardEl=el('section','voice-call-board');boardEl.id='voiceCallBoard';var avatarZone=el('section','voice-call-avatar-zone');avatarHost=el('div','voice-call-avatar');bubbleEl=el('div','voice-call-bubble','准备好了，想从哪里开始？');var actions=el('div','voice-call-actions');
    var interrupt=el('button','voice-call-interrupt','打断并说话');interrupt.id='voiceCallInterrupt';interrupt.onclick=interruptCall;
    var listen=el('button','','继续聆听');listen.id='voiceCallListen';listen.onclick=function(){if(finalizedTurns.length)drainFinalizedTurns(false);else startListening();};actions.append(interrupt,listen);avatarZone.append(avatarHost,bubbleEl,actions);body.append(boardEl,avatarZone);
    var foot=el('footer','voice-call-transcript-shell');transcriptEl=el('div','voice-call-transcript');transcriptEl.setAttribute('aria-live','polite');var fallback=el('div','voice-call-actions');textFallback=el('input','','');textFallback.id='voiceCallTextFallback';textFallback.placeholder='语音不可用时，可在这里继续当前通话';var send=el('button','','发送');send.onclick=function(){var value=textFallback.value.trim();if(value){textFallback.value='';submitUtterance(value);}};fallback.append(textFallback,send);recoveryEl=el('div','voice-call-recovery');recoveryEl.hidden=true;recoveryActionsEl=el('div','voice-call-actions');recoveryActionsEl.hidden=true;var retryPermission=el('button','','重新授权');retryPermission.id='voiceCallRetryPermission';retryPermission.onclick=startListening;var useTextFallback=el('button','','使用文字继续');useTextFallback.id='voiceCallUseTextFallback';useTextFallback.onclick=function(){if(textFallback){textFallback.focus();textFallback.scrollIntoView({block:'nearest'});}};recoveryActionsEl.append(retryPermission,useTextFallback);var right=el('div','');right.append(fallback,recoveryEl,recoveryActionsEl);foot.append(transcriptEl,right);rootEl.append(head,body,foot);app.appendChild(rootEl);
    avatar=createFixedImageAvatar(avatarHost);if(avatar&&speech&&speech.setPlaybackElement&&avatar.getAudioElement)speech.setPlaybackElement(avatar.getAudioElement(),{channel:'voice_call'});var Board=env.KakiTeachingBoard;if(Board&&Board.createRenderer)board=Board.createRenderer(boardEl,{onStep:focusTeachingStep});
  }
  function start(source,options){buildUi();if(!rootEl)return false;if(active&&!ending)return true;active=true;ending=false;stopPromise=null;micMuted=false;outputMuted=false;speechQueue=[];speechBuffer='';lastAssistant='';lastUser='';lastBoardText='';formalSendInFlight=false;speechStartedThisTurn=false;firstAssistantChunkSeen=false;finalizedTurns=[];clearBridgeTimer();callContext=Object.assign({},prewarmed||{},bridge()&&bridge().getCallContext?bridge().getCallContext():{},options&&options.context||{});rootEl.hidden=false;announceCallState(true);rootEl.dataset.source=source||'assistant';rootEl.dataset.teaching='false';transcriptEl.innerHTML='';setRecovery('');if(avatar)avatar.setState('idle');if(avatar&&speech&&speech.setPlaybackElement&&avatar.getAudioElement)speech.setPlaybackElement(avatar.getAudioElement(),{channel:'voice_call'});setState('requesting_permission','正在准备同一学习上下文和麦克风。');if(prewarmed&&board){board.skeleton(prewarmed.board_template||'step_explanation',(prewarmed.current_object||{}).title||'当前知识点');}startListening();return true;}
  function announceCallState(active){if(env.dispatchEvent&&env.CustomEvent)env.dispatchEvent(new env.CustomEvent('kaki:voice-call-state',{detail:{active:Boolean(active)}}));}
  function stop(reason){
    if(!active)return Promise.resolve(true);if(stopPromise)return stopPromise;ending=true;clearBridgeTimer();stopRecognition();stopSpeech(false);setTeaching(false);if(avatar)avatar.setState('listening');setState('listening',finalizedTurns.length?'正在保存你最后一句话…':'正在完成本轮会话记录…');
    stopPromise=(async function(){var flushed=await drainFinalizedTurns(true);if(!flushed||finalizedTurns.length)throw new Error('最后一条 finalized utterance 尚未写入正式 Conversation，通话保持打开。');await waitForFormalIdle(45000);active=false;formalSendInFlight=false;ending=false;setState('ended','这次通话已结束，你仍在原来的学习上下文里。');if(avatar)avatar.setState('idle');var companion=env.digitalTutorAdapter;if(speech&&speech.setPlaybackElement&&companion&&companion.getAudioElement)speech.setPlaybackElement(companion.getAudioElement(),{channel:'companion'});(env.setTimeout||setTimeout)(function(){if(rootEl&&!active){rootEl.hidden=true;announceCallState(false);}},260);var b=bridge();if(b&&b.restoreAfterCall)b.restoreAfterCall(reason||'ended');return true;})().catch(function(error){ending=false;setState('recoverable_error','最后一句还没有安全保存，通话不会假装已经结束。');setRecovery(error&&error.message||'最后一句保存失败。');return false;}).finally(function(){stopPromise=null;});return stopPromise;
  }
  function prewarmContext(context){prewarmed=Object.assign({},context||{});var action=prewarmed.tutor_public&&prewarmed.tutor_public.action||'';prewarmed.board_template=action==='misconception_distinction'?'comparison_board':(action==='transfer_challenge'?'flow':'step_explanation');prewarmed.voice_persona=speech&&speech.getPersona?speech.getPersona():null;return {prewarmed:true,board_template:prewarmed.board_template,voice_persona:prewarmed.voice_persona};}
  function onFormalSendStart(payload){if(!active)return;formalSendInFlight=true;speechStartedThisTurn=false;firstAssistantChunkSeen=false;speechBuffer='';setState('thinking','我听到了，正在结合当前学习内容回答。');callContext=Object.assign({},callContext||{},payload&&payload.context||{});scheduleNaturalBridge();}
  function onAssistantChunk(chunk,full){if(!active)return;firstAssistantChunkSeen=true;clearBridgeTimer();lastAssistant=String(full||'');if(bubbleEl)bubbleEl.textContent=cleanDisplayText(lastAssistant)||'正在回答…';if(ending)return;speechBuffer+=String(chunk||'');flushSpeechBuffer(false);updateBoard(lastAssistant);}
  function onFormalSendDone(answer){if(!active)return;formalSendInFlight=false;clearBridgeTimer();lastAssistant=String(answer||lastAssistant||'');appendTranscript('assistant',lastAssistant);if(ending)return;flushSpeechBuffer(true);updateBoard(lastAssistant);if(!speechQueue.length&&!speakingQueue){if(!speechStartedThisTurn&&speech&&speech.supported()&&!outputMuted)enqueueSpeech(lastAssistant);else if(!micMuted){setState(rootEl&&rootEl.dataset.teaching==='true'?'teaching':'listening',lastAssistant);startListening();}}}
  function onFormalSendError(message){if(!active)return;formalSendInFlight=false;clearBridgeTimer();stopSpeech(false);setState('recoverable_error','这次回答没有完成。');setRecovery(message||'可以重试上一句话，或继续用文字。');}
  function providerStatus(){return speech&&speech.getProviderStatus?speech.getProviderStatus():'REAL_VOICE_PROVIDER_BLOCKED';}
  buildUi();
  directButton=env.document&&env.document.getElementById('callTool');
  directButtonHandler=function(){start('assistant_entry');};
  if(directButton)directButton.addEventListener('click',directButtonHandler);
  function destroy(){clearBridgeTimer();clearTeachingAttentionTimer();if(active){ending=false;active=false;stopRecognition();stopSpeech(false);announceCallState(false);}if(directButton&&directButtonHandler)directButton.removeEventListener('click',directButtonHandler);if(avatar&&avatar.destroy)avatar.destroy();if(rootEl&&rootEl.parentNode)rootEl.parentNode.removeChild(rootEl);rootEl=null;}
  return {runtime_version:'KAKI_VOICE_CALL_RUNTIME_V3_CONTINUITY',start:start,stop:stop,prewarm:prewarmContext,interrupt:interruptCall,replay:function(){if(lastAssistant&&!ending){stopSpeech(false);enqueueSpeech(lastAssistant);}},submitUtterance:submitUtterance,flushFinalizedTurns:function(){return drainFinalizedTurns(true);},onFormalSendStart:onFormalSendStart,onAssistantChunk:onAssistantChunk,onFormalSendDone:onFormalSendDone,onFormalSendError:onFormalSendError,getCapabilities:capabilities,checkReadiness:checkReadiness,getProviderStatus:providerStatus,destroy:destroy,getState:function(){return{active:active,ending:ending,state:state,mic_muted:micMuted,output_muted:outputMuted,formal_send_in_flight:formalSendInFlight,pending_finalized_count:finalizedTurns.length,teaching:rootEl&&rootEl.dataset.teaching==='true',capture_error:lastCaptureError,context:callContext,voice:speech&&speech.getPersona?speech.getPersona():null,avatar:avatar&&avatar.getState?avatar.getState():null};}};
}));
