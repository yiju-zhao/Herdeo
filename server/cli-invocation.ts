const commands:Record<string,Set<string>>={
 claude:new Set(['agents','attach','auth','auto-mode','doctor','gateway','import','install','logs','mcp','plugin','plugins','purge','respawn','rm','setup-token','stop','kill','ultrareview','update','upgrade','remote-control','daemon','help']),
 pi:new Set(['install','remove','uninstall','update','list','config','auth','mcp','help']),
 codex:new Set(['exec','e','review','login','logout','mcp','mcp-server','app-server','completion','sandbox','debug','apply','features','help']),
};
/** Only a normal interactive agent is eligible for a live terminal connector. */
export function isDirectCliInvocation(kind:string,args:readonly string[]){
 const beforeSeparator=args.indexOf('--');const flags=beforeSeparator<0?args:args.slice(0,beforeSeparator);
 if(commands[kind]?.has(args[0]??''))return true;
 return flags.some(a=>['--version','-V','-v','--help','-h','--print','-p','--mode','--input-format','--output-format','--init-only','--list-models','--export','--bare','--no-extensions','--no-mcp','--remote'].includes(a)||['--mode=','--input-format=','--output-format=','--list-models=','--export='].some(p=>a.startsWith(p)));
}
