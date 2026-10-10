exports.up = pgm => {
  pgm.createTable('ac_accounts', {
    id:{type:'uuid',primaryKey:true}, login:{type:'varchar(120)',notNull:true,unique:true},
    display_name:{type:'varchar(40)',notNull:true}, password_hash:{type:'text',notNull:true},
    status:{type:'text',notNull:true,check:"status IN ('active','disabled')"}, created_at:{type:'timestamptz',notNull:true,default:pgm.func('now()')}
  });
  pgm.createTable('ac_sessions',{sid:{type:'varchar',primaryKey:true},sess:{type:'json',notNull:true},expire:{type:'timestamp(6)',notNull:true}});
  pgm.createIndex('ac_sessions','expire');
};
exports.down = pgm => {pgm.dropTable('ac_sessions');pgm.dropTable('ac_accounts');};
